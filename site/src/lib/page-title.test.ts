/**
 * A page's <title> carries its kind's word, read from where its source sits.
 *
 * The cases run against a small structure, so the suite does not move when the
 * real file does, plus one read of the real file.
 */
import { describe, expect, it } from 'vitest';

import { placedPages, type Structure } from '../../../tools/src/lib/site-routes';
import { HOME_TAGLINE, MAX_TITLE, nounOf, PATTERN_HUB_NOUN, titleFor } from './page-title';

const hub = { description: 'd', intro: 'i', tags: [] };
const tiny: Structure = {
  areas: [
    { id: 'patterns', label: 'Patterns', hub, pages: [] },
    {
      id: 'resilience',
      label: 'Resilience',
      nestUnder: 'patterns',
      hub,
      pages: [
        {
          slug: 'circuit-breaker',
          label: 'Circuit Breaker',
          source: 'docs/patterns/distributed/resilience/circuit-breaker.md',
        },
        {
          slug: 'rate-limiter',
          label: 'Rate Limiter',
          source: 'docs/patterns/distributed/resilience/rate-limiter.md',
        },
      ],
    },
    {
      id: 'designs',
      label: 'Case studies',
      hub,
      pages: [
        {
          slug: 'design-rate-limiter',
          label: 'Rate Limiter',
          source: 'docs/designs/design-rate-limiter.md',
        },
        { slug: 'cap', label: 'CAP', source: 'docs/themes/cap.md' },
      ],
    },
    {
      id: 'themes',
      label: 'Themes',
      hub,
      pages: [{ slug: 'resilience', label: 'Resilience', source: 'docs/themes/resilience.md' }],
    },
    {
      id: 'hazards',
      label: 'Hazards',
      hub,
      pages: [{ slug: 'god-object', label: 'God Object', source: 'docs/hazards/god-object.md' }],
    },
    {
      id: 'principles',
      label: 'Principles',
      hub,
      pages: [{ slug: 'dry', label: 'DRY', source: 'docs/principles/dry.md' }],
    },
    {
      id: 'capabilities',
      label: 'Capabilities',
      hub,
      pages: [
        {
          slug: 'key-value',
          label: 'Key-value & cache stores',
          source: 'docs/capabilities/key-value.md',
        },
      ],
    },
    {
      id: 'comparisons',
      label: 'Comparisons',
      hub,
      pages: [
        {
          slug: 'identity-providers',
          label: 'Identity providers',
          source: 'docs/comparisons/identity-providers.md',
        },
      ],
    },
    {
      id: 'map',
      label: 'Map',
      nav: 'link',
      hub,
      pages: [{ slug: 'stack', label: 'S', source: 'generated', route: '/map/stack.html' }],
    },
  ],
};

const SUFFIX = ' · Software Design Atlas';

/** The route `slug` builds in the small structure. */
const at = (slug: string): string =>
  (placedPages(tiny).find((p) => p.slug === slug) as { route: string }).route;

/** The title of the page at `slug`, given the title Starlight would write for it. */
const titleOf = (slug: string, title: string): string =>
  titleFor(at(slug), title, `${title}${SUFFIX}`, tiny);

describe('titleFor', () => {
  it('puts the word a searcher types for the kind after the title, before the site name', () => {
    expect(titleOf('circuit-breaker', 'Circuit Breaker')).toBe(`Circuit Breaker pattern${SUFFIX}`);
    expect(titleOf('god-object', 'God Object')).toBe(`God Object anti-pattern${SUFFIX}`);
    expect(titleOf('dry', 'DRY')).toBe(`DRY principle${SUFFIX}`);
    expect(titleOf('identity-providers', 'Identity providers')).toBe(
      `Identity providers compared${SUFFIX}`,
    );
  });

  it('tells apart a case study and a pattern that share a name', () => {
    const pattern = titleOf('rate-limiter', 'Rate Limiter');
    const study = titleOf('design-rate-limiter', 'Rate Limiter');
    expect(pattern).toBe(`Rate Limiter pattern${SUFFIX}`);
    expect(study).toBe(`Rate Limiter system design${SUFFIX}`);
    expect(pattern).not.toBe(study);
  });

  it('drops the site name from a title that would pass MAX_TITLE characters', () => {
    const named = 'Key-value & cache stores on AWS, Azure and Google Cloud';
    expect(`${named}${SUFFIX}`.length).toBeGreaterThan(MAX_TITLE);
    expect(titleOf('key-value', 'Key-value & cache stores')).toBe(named);
  });

  it('reads the kind from the source folder, so a theme filed under a case-study area stays plain', () => {
    expect(titleOf('cap', 'CAP')).toBe(`CAP${SUFFIX}`);
    expect(titleOf('resilience', 'Resilience')).toBe(`Resilience${SUFFIX}`);
  });

  it('names a hub of the patterns tree as a family, unlike the theme of the same name', () => {
    expect(titleFor('/patterns/resilience.html', 'Resilience', `Resilience${SUFFIX}`, tiny)).toBe(
      `Resilience ${PATTERN_HUB_NOUN}${SUFFIX}`,
    );
    expect(
      titleFor('/patterns/resilience.html', 'Resilience', `Resilience${SUFFIX}`, tiny),
    ).not.toBe(titleOf('resilience', 'Resilience'));
  });

  it('leaves a title that already holds its word, and a hub outside the patterns tree, alone', () => {
    expect(titleFor('/patterns.html', 'Patterns', `Patterns${SUFFIX}`, tiny)).toBe(
      `Patterns${SUFFIX}`,
    );
    expect(titleFor('/designs.html', 'Case studies', `Case studies${SUFFIX}`, tiny)).toBe(
      `Case studies${SUFFIX}`,
    );
    expect(titleOf('circuit-breaker', 'Circuit Breaker Pattern')).toBe(
      `Circuit Breaker Pattern${SUFFIX}`,
    );
  });

  it('gives the home page what the site holds instead of its name twice', () => {
    expect(
      titleFor('/index.html', 'Software Design Atlas', `Software Design Atlas${SUFFIX}`, tiny),
    ).toBe(`Software Design Atlas: ${HOME_TAGLINE}`);
  });

  it('leaves the tool pages, generated pages, unknown routes and unexpected text as Starlight wrote them', () => {
    expect(titleFor('/404.html', 'Page not found', `Page not found${SUFFIX}`, tiny)).toBe(
      `Page not found${SUFFIX}`,
    );
    expect(titleFor('/map/stack.html', 'Stack', `Stack${SUFFIX}`, tiny)).toBe(`Stack${SUFFIX}`);
    expect(titleFor('/nowhere.html', 'Nowhere', `Nowhere${SUFFIX}`, tiny)).toBe(`Nowhere${SUFFIX}`);
    expect(titleFor(null, 'Marks', `Marks${SUFFIX}`, tiny)).toBe(`Marks${SUFFIX}`);
    expect(titleFor(at('circuit-breaker'), 'Circuit Breaker', 'Something else', tiny)).toBe(
      'Something else',
    );
  });
});

describe('nounOf', () => {
  it('reads the real structure file by default', () => {
    expect(nounOf('/patterns/distributed/resilience/circuit-breaker.html')).toBe('pattern');
    expect(nounOf('/patterns/distributed/resilience.html')).toBe(PATTERN_HUB_NOUN);
  });

  it('answers no word for no route', () => {
    expect(nounOf(null, tiny)).toBe('');
  });
});
