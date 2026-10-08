// A built page's <title>: the page's own title, the word a searcher adds for
// its kind, then the site name.
//
// A search result shows the <title>, and a searcher types the kind beside the
// name: "circuit breaker pattern", "rate limiter system design". The h1,
// og:title and the JSON-LD headline keep the bare title, which the manifest
// reads as the page's name. The kind word also tells apart pages that share a
// name: the Rate Limiter case study and the Rate Limiter pattern, or a hub of
// the patterns tree and the theme of the same name.
//
// Starlight writes the title as `{title} {delimiter} {site name}`
// (site/astro.config.mjs). The word goes in right after the title, so the
// delimiter and the site name stay as configured. Past MAX_TITLE characters
// the site name is dropped, because a search result cuts the end of a long
// title anyway. The home page says what the site holds rather than repeating
// its own name.
import structureFile from '../../../docs/data/site-structure.json';
import { kindOfArea } from '../../../tools/src/lib/search-score';
import { fromPageTree, placedPages, type Structure } from '../../../tools/src/lib/site-routes';

import { areaOfRoute, isHub, topAreaOf } from './routes';

const structure = structureFile as Structure;

/** The longest title a search result shows whole. */
export const MAX_TITLE = 60;

/** What the home page's title says after the site name. */
export const HOME_TAGLINE = 'design patterns and system design';

/**
 * The word a searcher adds for each page kind, keyed by kb.mjs's kind. A
 * theme adds none: a theme's title is already the phrase people search for.
 */
export const KIND_NOUN: Readonly<Record<string, string>> = {
  pattern: 'pattern',
  design: 'system design',
  hazard: 'anti-pattern',
  principle: 'principle',
  comparison: 'compared',
  capability: 'on AWS, Azure and Google Cloud',
};

/** The word a hub of the patterns tree adds: its label names a family of patterns. */
export const PATTERN_HUB_NOUN = 'patterns';

/**
 * The word `route`'s title takes, or '' for none. A page takes its kind's word,
 * read from the folder its source sits in, not from its area: a theme filed
 * under a case-study area is still a theme. A hub takes one only in the
 * patterns tree. The home page, the tool pages and the generated pages take none.
 */
export function nounOf(route: string | null, from: Structure = structure): string {
  if (route === null) return '';
  if (isHub(route, from)) {
    const area = areaOfRoute(route, from);
    return area !== undefined && topAreaOf(area, from) === 'patterns' ? PATTERN_HUB_NOUN : '';
  }
  const page = placedPages(from).find((p) => p.route === route && fromPageTree(p));
  const folder = page === undefined ? undefined : /^docs\/([^/]+)\//.exec(page.source)?.[1];
  return folder === undefined ? '' : (KIND_NOUN[kindOfArea(folder)] ?? '');
}

/**
 * The `<title>` for `route`, given the page's own `title` and the text
 * Starlight wrote for it (`content`). A title that already holds its kind's
 * word, and content that does not begin with the title, are left as they are.
 */
export function titleFor(
  route: string | null,
  title: string,
  content: string,
  from: Structure = structure,
): string {
  if (route === '/index.html') return `${title}: ${HOME_TAGLINE}`;
  const noun = nounOf(route, from);
  if (
    noun === '' ||
    !content.startsWith(title) ||
    title.toLowerCase().includes(noun.toLowerCase())
  ) {
    return content;
  }
  const named = `${title} ${noun}`;
  const whole = named + content.slice(title.length);
  return whole.length <= MAX_TITLE ? whole : named;
}
