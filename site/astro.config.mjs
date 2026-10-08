// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import rehypeMermaid from 'rehype-mermaid';

import { rehypeKbDiagrams, rehypeKbTables, remarkKbSite } from '../tools/src/lib/site-markdown.ts';
import { linkPage, navOf, placedHubs, placedPages } from '../tools/src/lib/site-routes.ts';
import { publicRoot, REPO_URL, SITE_NAME, SOCIAL_IMAGE } from '../tools/src/site/site-output.ts';

// The sidebar is not authored here: docs/data/site-structure.json is the one
// structure source — area order, page order, labels, nesting — shared with the
// mirror (tools/src/site/gen-site-docs.ts), the hubs (gen-site-hubs.ts) and the
// post-build passes, and tools/src/lib/site-routes.ts says where each page and
// hub lands. Edit the JSON, never this list.
/** The link preview's picture, absolute: a preview fetches it from another site. */
const socialImage = new URL(SOCIAL_IMAGE.path, publicRoot()).href;

/** @type {import('../tools/src/lib/site-routes.ts').Structure} */
const structure = JSON.parse(
  readFileSync(new URL('../docs/data/site-structure.json', import.meta.url), 'utf8'),
);

function sidebarFromStructure() {
  const hubs = new Map(placedHubs(structure).map((h) => [h.area, h.route]));
  const pages = placedPages(structure);
  /** @type {Map<string, { label: string, collapsed: boolean, items: any[] }>} */
  const byId = new Map();
  /** @type {any[]} */
  const top = [];
  for (const area of structure.areas) {
    // `none` is off the site; `link` is one top-level link to its only row.
    if (navOf(area) === 'none') continue;
    if (navOf(area) === 'link') {
      const row = /** @type {NonNullable<ReturnType<typeof linkPage>>} */ (
        linkPage(structure, area.id)
      );
      top.push({ label: area.label, link: row.route });
      continue;
    }
    const entry = {
      label: area.label,
      collapsed: true,
      items: [
        { label: 'Overview', link: hubs.get(area.id) },
        ...pages.filter((p) => p.area === area.id).map((p) => ({ label: p.label, link: p.route })),
      ],
    };
    byId.set(area.id, entry);
    if (area.nestUnder === undefined) top.push(entry);
  }
  for (const area of structure.areas) {
    const entry = byId.get(area.id);
    if (area.nestUnder !== undefined && entry !== undefined)
      byId.get(area.nestUnder)?.items.push(entry);
  }
  return top;
}

// EDITING A remark OR rehype PLUGIN: Astro caches rendered markdown in
// node_modules/.astro and keys the cache on the source file, not on this config
// — so a changed plugin silently rebuilds every unchanged page from the previous
// build's HTML. `make site-clean` clears it (build-command-C10).
//
// The site has to open from a local folder, with no server (spec kb.site.offline).
// `file://` blocks fetch(), ES-module scripts, root-absolute links and the
// directory-URL → index.html resolution browsers do over HTTP:
//
//   build.format: 'file'  → patterns/caching/cache-aside.html, a real file, the
//                           route every inbound link already uses
//   base: '/'             → no origin-rooted prefix to escape from
//   pagefind: false       → Starlight's search fetches an index
//
// Links are made depth-relative afterwards by tools/src/site/site-portable.ts.
// The rest serve readable output: no compression, one linked stylesheet, no
// inlined chunk (offline output-settings).
//
// `site` is the published root's origin only. The site is served under a
// project path (PUBLIC_ROOT, under the repository's name), but a base path
// would prefix every route Starlight writes and none this repo's components
// write; so the build writes absolute URLs from the origin and the post-build
// pass moves the canonical link, og:url and sitemap under the root
// (publicRoot and toPublic in tools/src/site/site-output.ts).
export default defineConfig({
  site: publicRoot().origin,
  base: '/',
  compressHTML: false,
  build: {
    format: 'file',
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      rolldownOptions: {
        // Astro's content-assets plugin (astro/dist/content/vite-plugin-content-assets.js)
        // writes "use astro:head-inject" into every .mdx page it bundles, and
        // Rolldown warns once per page that it may drop the directive. Astro
        // reads the directive itself, so the warning names nothing to fix
        // here; every other log passes through.
        onLog(level, log, handler) {
          if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('astro:head-inject'))
            return;
          handler(level, log);
        },
      },
    },
    // Resolve links the way Node was told to. A checkout whose packages are
    // links into another one (the build command's scenario tests,
    // tools/src/site/site-build.test.ts) runs with --preserve-symlinks, and
    // Vite must then keep the linked paths too, or it reads every package as
    // a file outside the project. Off in an ordinary install.
    resolve: {
      preserveSymlinks: /--preserve-symlinks\b/.test(process.env.NODE_OPTIONS ?? ''),
    },
  },
  markdown: {
    // Sätteri is Astro's default Markdown processor from 7.3 and runs no remark
    // or rehype plugin; the `unified` processor is what these need.
    //
    // remarkKbSite reads the dialect's data layer (tools/src/lib/kb-attrs.ts)
    // into bare data-* on class-free elements; rehype-mermaid turns each
    // diagram fence into inline SVG at build time, in headless Chromium, since
    // no module script could draw it from file://; rehypeKbDiagrams frames it,
    // and rehypeKbTables makes each anchored row's first cell its row header.
    // Smartypants is off: it would turn the authored `"`, `--` and `...` into
    // other characters, and the built text must say what the page says.
    processor: unified({
      smartypants: false,
      remarkPlugins: [remarkKbSite],
      rehypePlugins: [
        [rehypeMermaid, { strategy: 'inline-svg' }],
        rehypeKbDiagrams,
        rehypeKbTables,
      ],
    }),
  },
  integrations: [
    starlight({
      title: SITE_NAME,
      // "Circuit Breaker · Software Design Atlas", the separator the HTML pages'
      // titles use. site/src/lib/page-title.ts adds the page's kind before it.
      titleDelimiter: '·',
      description:
        'A knowledge base of software design patterns, design case studies, themes, hazards, principles, cloud capabilities and product comparisons.',
      // Pagefind's runtime fetches a search index — impossible from file://.
      pagefind: false,
      // The picture a link preview shows, absolute under the published root as
      // a preview needs it, and the icon a phone keeps for a saved page. The
      // root-relative icon href is made depth-relative by the post-build pass.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: socialImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: String(SOCIAL_IMAGE.width) } },
        {
          tag: 'meta',
          attrs: { property: 'og:image:height', content: String(SOCIAL_IMAGE.height) },
        },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: SOCIAL_IMAGE.alt } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: socialImage } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
      ],
      // The not-found page is hand-written in src/content/docs/404.mdx, so it
      // carries the page facts every built page does. GitHub Pages serves the
      // built 404.html for any address the site does not hold.
      //
      // The docs catch-all route already renders that entry to 404.html, as it
      // does every page. Starlight's own /404 route would claim the same file,
      // and the build would warn that one of them was dropped.
      disable404Route: true,
      // Drops the outline of a page that has fewer than two entries.
      routeMiddleware: './src/route-middleware.ts',
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: [
        './src/styles/layout.css',
        './src/styles/tokens.css',
        './src/styles/primitives.css',
        './src/components/CopyButton/copy.css',
        './src/components/Breadcrumbs/breadcrumbs.css',
        './src/components/DiagramTools/diagram-tools.css',
        './src/components/Facets/facets.css',
        './src/components/Favourites/favourites.css',
        './src/components/Marks/marks.css',
        './src/components/HomeSearch/home-search.css',
        './src/components/MentionedBy/mentioned-by.css',
        './src/components/MobileMenuToggle/mobile-menu-toggle.css',
        './src/components/NextSteps/next-steps.css',
        './src/components/PageIntro/page-intro.css',
        './src/components/PageMeta/page-meta.css',
        './src/components/PageTitle/page-title.css',
        './src/components/Practiced/practiced.css',
        './src/components/PrerequisiteCard/prerequisite-card.css',
        './src/components/Search/search.css',
        './src/components/SectionHub/section-hub.css',
        './src/components/Shield/shield.css',
        './src/components/Sidebar/sidebar.css',
        './src/components/StartHere/start-here.css',
        './src/components/StackIndex/stack-index.css',
        './src/components/ThemeToggle/theme-toggle.css',
        './src/components/TocTracking/toc-tracking.css',
        './src/components/ViewSource/view-source.css',
      ],
      components: {
        // The kb:* meta tags, the JSON-LD block, the search payload and the
        // one kb bundle.
        Head: './src/components/Head/Head.astro',
        // Starlight's wrapper around the rendered body, plus the data-kb-region
        // hook every reader of a built page finds the knowledge region by, the
        // prerequisite card at its top, and after it the "Mentioned by" aside.
        MarkdownContent: './src/components/MarkdownContent/MarkdownContent.astro',
        // Breadcrumb trail, Starlight's title, then the purpose line inside a
        // class-free title block, and on a page the reader's controls: the
        // favourite star, the practiced check.
        PageTitle: './src/components/PageTitle/PageTitle.astro',
        // The search box: a header button and a dialog ranked from window.kb,
        // since Pagefind's dialog fetches its index and a folder serves nothing.
        Search: './src/components/Search/Search.astro',
        // Previous, up and next at the foot of a page: the sidebar order the
        // structure file builds, and the hub above.
        Pagination: './src/components/NextSteps/NextSteps.astro',
        // A cycling auto/dark/light button whose behaviour rides in the bundle,
        // so unlike upstream's module script it works from file://.
        ThemeSelect: './src/components/ThemeToggle/ThemeToggle.astro',
        ThemeProvider: './src/components/ThemeProvider/ThemeProvider.astro',
        MobileMenuToggle: './src/components/MobileMenuToggle/MobileMenuToggle.astro',
        // One locale: the picker never shows, but its script would ship.
        LanguageSelect: './src/components/LanguageSelect/LanguageSelect.astro',
        // "What a machine reads here", beside the social links.
        SocialIcons: './src/components/SocialIcons/SocialIcons.astro',
        TableOfContents: './src/components/TocTracking/TableOfContents.astro',
        // The current branch only: the top-level areas, and the area holding
        // this page open down to its pages. The full sidebar below stays the
        // route data, so the pager's previous and next still walk every page.
        Sidebar: './src/components/Sidebar/Sidebar.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      sidebar: sidebarFromStructure(),
    }),
  ],
});
