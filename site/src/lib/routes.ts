// The one way a component learns a page's route and its place among the areas.
//
// Routes are files (`build.format: 'file'`): a content entry at `a/b/c.md`
// builds `/a/b/c.html`, and a hub at `a/b/index.mdx` builds `/a/b.html`, beside
// its folder. The route comes from the content file path — the field git-date.ts
// keys off too — because the id scheme is the loader's business and has changed
// between Astro majors, while the file path belongs to this repo.
//
// Where an area's hub lands is not worked out here: tools/src/lib/site-routes.ts
// answers it for the mirror, the hub generator and the post-build passes, and
// this file asks it too, so the breadcrumbs cannot point anywhere the hubs are not.
import structureFile from '../../../docs/data/site-structure.json';
import {
  areaChain,
  fromPageTree,
  placedHubs,
  placedPages,
  type Structure,
} from '../../../tools/src/lib/site-routes';

const structure = structureFile as Structure;

/** The route a content file builds, or null for a path outside the collection. */
export function routeOf(filePath: string | undefined | null): string | null {
  if (!filePath) return null;
  const m = /src\/content\/docs\/(.*)\.(md|mdx)$/.exec(String(filePath).replace(/\\/g, '/'));
  if (!m) return null;
  const slug = m[1].replace(/(^|\/)index$/, '');
  return slug === '' ? '/index.html' : `/${slug}.html`;
}

/**
 * The pages that are tools or answers, not pages of the tree: the reader's
 * marks and the not-found page. They sit under no hub, so they have no trail,
 * and their way up is the home page.
 */
export const NOT_FOUND = '/404.html';

export const TOOL_ROUTES: readonly string[] = ['/marks.html', NOT_FOUND];

/**
 * The pages with no sidebar of their own that still carry the phone menu: the
 * home page and the tool pages. The menu is the only way to the navigation, the
 * theme and the marks on a phone; a desktop pins no sidebar beside them.
 */
export function isMenuOnly(route: string | null): boolean {
  return route === '/index.html' || isTool(route);
}

/** Is `route` one of the tool pages (marks, not found)? */
export function isTool(route: string | null): boolean {
  return route !== null && TOOL_ROUTES.includes(route);
}

/** One step of a breadcrumb trail. */
export interface Crumb {
  href: string;
  label: string;
}

/**
 * The hubs above a page, outermost first: the hub of every area its `area`
 * nests under, then its own area's hub — unless the page is that hub. An
 * area with no placed hub (a `link` or `none` area) adds no crumb, so a
 * single-page area's page has no trail. An area the structure file does not
 * hold gives no trail. Each hub is named by its area's label.
 */
export function trailOf(area: string, route: string | null, from: Structure = structure): Crumb[] {
  if (!from.areas.some((a) => a.id === area) || isTool(route)) return [];
  const hubs = new Map(placedHubs(from).map((h) => [h.area, h.route]));
  return areaChain(from, area)
    .filter((a) => hubs.has(a.id))
    .map((a) => ({ href: hubs.get(a.id) as string, label: a.label }))
    .filter((c) => c.href !== route);
}

/** One step of the trail a page shows: a link up, or the page itself, which has no link. */
export interface TrailStep {
  href: string | null;
  label: string;
}

/**
 * The trail the breadcrumbs show and the JSON-LD names: Home, every hub above
 * the page, then the page itself. The home page and the not-found page have
 * none; the marks page, a tool outside the tree, reads Home › My marks. One
 * function feeds both, so what a reader sees and what a crawler reads agree.
 */
export function crumbsOf(
  area: string,
  route: string | null,
  title: string,
  from: Structure = structure,
): TrailStep[] {
  if (route === null || route === '/index.html' || route === NOT_FOUND) return [];
  return [
    { href: '/index.html', label: 'Home' },
    ...trailOf(area, route, from),
    { href: null, label: title },
  ];
}

/**
 * Up from a page: the hub that holds it — for a hub, the hub above it — or
 * the home page when nothing is above. The home page itself has no up.
 */
export function upOf(
  area: string,
  route: string | null,
  from: Structure = structure,
): Crumb | null {
  if (route === null || route === '/index.html') return null;
  const trail = trailOf(area, route, from);
  return trail[trail.length - 1] ?? { href: '/index.html', label: 'Home' };
}

/**
 * The name a pager link shows. Starlight's pagination walks the sidebar, where
 * every hub is an area's "Overview"; out of the sidebar that word names
 * nothing, so a hub's link says its area's label instead.
 */
export function pagerLabel(href: string, label: string, from: Structure = structure): string {
  const hub = placedHubs(from).find((h) => h.route === href);
  const area = hub === undefined ? undefined : from.areas.find((a) => a.id === hub.area);
  return area === undefined ? label : area.label;
}

/**
 * Is `route` a page of the page tree — not a hub, not the home page, not a
 * page a generator writes (the map's)? A page gets the reader's own controls
 * under its title (PageTitle); a hub carries them on its rows instead, and a
 * generated page has no prose to read at a level nor to mark as practiced.
 */
export function isPage(route: string | null, from: Structure = structure): boolean {
  return route !== null && placedPages(from).some((p) => p.route === route && fromPageTree(p));
}

/** The outermost area an area nests under: itself when it nests under none. */
export function topAreaOf(area: string, from: Structure = structure): string | undefined {
  return from.areas.some((a) => a.id === area) ? areaChain(from, area)[0]?.id : undefined;
}

/** Is `route` the hub of an area? */
export function isHub(route: string | null, from: Structure = structure): boolean {
  return route !== null && placedHubs(from).some((h) => h.route === route);
}

/**
 * The outermost area a built route belongs to, whether it is a page or a hub;
 * undefined for a route the structure holds neither of (the home page, a tool).
 */
export function topAreaOfRoute(route: string, from: Structure = structure): string | undefined {
  const hub = placedHubs(from).find((h) => h.route === route);
  const page = hub === undefined ? placedPages(from).find((p) => p.route === route) : undefined;
  const area = hub?.area ?? page?.area;
  return area === undefined ? undefined : topAreaOf(area, from);
}

/**
 * The area a built route belongs to: a page's own area, or the area a hub
 * stands for; undefined for the home page and the tool pages.
 */
export function areaOfRoute(route: string, from: Structure = structure): string | undefined {
  const hub = placedHubs(from).find((h) => h.route === route);
  return hub?.area ?? placedPages(from).find((p) => p.route === route)?.area;
}

/** An area's label, or undefined for an id the structure does not hold. */
export function areaLabel(area: string, from: Structure = structure): string | undefined {
  return from.areas.find((a) => a.id === area)?.label;
}
