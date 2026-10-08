// Starlight route middleware: runs for every page before it renders.
//
// A page whose outline holds fewer than two entries loses it, and with it the
// reading rail on a wide screen and the "On this page" bar on a phone: Starlight
// draws neither for a page with no outline. A hub's outline is its one
// "Overview" entry, which is a rail with nothing to jump to.
//
// The <title> gains the word a searcher types for the page's kind
// (lib/page-title.ts). Only the head's title entry changes: the h1, og:title
// and the JSON-LD headline keep the page's own title.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { titleFor } from './lib/page-title';
import { isMenuOnly, routeOf } from './lib/routes';
import { worthShowing } from './lib/toc';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (route.toc && !worthShowing(route.toc.items)) route.toc = undefined;
  // The home page, the marks page and the not-found page have no sidebar of
  // their own, and Starlight draws the phone menu only for a page that has
  // one. Giving them the sidebar puts the menu button, the theme toggle and
  // the marks link on a phone; a desktop hides the pinned pane for them
  // (Sidebar.astro marks these pages, sidebar.css hides it).
  if (isMenuOnly(routeOf(route.entry?.filePath))) route.hasSidebar = true;
  const title = route.head?.find((entry) => entry.tag === 'title');
  const own = route.entry?.data?.title;
  if (title !== undefined && typeof title.content === 'string' && typeof own === 'string') {
    title.content = titleFor(routeOf(route.entry?.filePath), own, title.content);
  }
});
