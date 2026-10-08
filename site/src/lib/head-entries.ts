// The head entries the route middleware adds or rewrites beside the title
// (page-title.ts): the robots meta that keeps the tool pages out of search,
// and the home page's canonical address.
//
// The tool pages, the reader's marks and the not-found page, hold nothing a
// search result could send anyone to. `noindex, follow` keeps them out of the
// index while a crawler still follows their links, and the post-build pass
// drops a page carrying it from the sitemap.
//
// The home page's canonical link and og:url name the root, as the sitemap
// does, rather than /index.html. Both addresses serve the same page, and one
// address keeps search from splitting it in two. The post-build pass then
// moves the root under the published one, as it does every canonical link.

/** One entry of Starlight's head list, as the middleware sees it. */
export interface HeadEntry {
  tag: string;
  attrs?: Record<string, string | boolean | undefined>;
  content?: string;
}

/** The robots meta a tool page carries: out of the index, links still followed. */
export function noindex(): HeadEntry {
  return { tag: 'meta', attrs: { name: 'robots', content: 'noindex, follow' } };
}

/** Point the canonical link and og:url at the root of the origin they name. */
export function canonicalAtRoot(head: HeadEntry[]): void {
  for (const entry of head) {
    const attrs = entry.attrs;
    if (attrs === undefined) continue;
    const key =
      entry.tag === 'link' && attrs['rel'] === 'canonical'
        ? 'href'
        : entry.tag === 'meta' && attrs['property'] === 'og:url'
          ? 'content'
          : null;
    const value = key === null ? undefined : attrs[key];
    if (key !== null && typeof value === 'string') attrs[key] = new URL('/', value).href;
  }
}
