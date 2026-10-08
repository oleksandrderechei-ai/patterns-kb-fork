/**
 * Shared test trees for the site build's steps and gates: a small published
 * page tree the mirror and the hub generator read, and a small built site in
 * the shape the post-build passes leave, which the site gates read. The suites
 * beside this file and the oracle scenarios build on them, so a sandbox looks
 * the same to every step that meets it.
 */

import { SCHEMA_DIR } from '../contract/contract.js';
import { Corpus } from '../kb/corpus.js';
import { recordOf } from '../kb/record.js';
import { writeRecordFixture } from '../lib/fixtures.js';
import type { Structure } from '../lib/site-routes.js';
import type { Sandbox } from '../lib/sandbox.js';
import { NOSCRIPT_STYLE } from '../lib/site-noise.js';
import { formatHtml } from './site-format.js';

/** The ignore rules that own the site's input folder, as the root .gitignore states them. */
export const SITE_GITIGNORE = [
  'site/dist/',
  'site/.astro/',
  'site/public/kb.js',
  'site/src/content/docs/**/*.md',
  'site/src/content/docs/*/**/index.mdx',
  'site/src/content/docs/map/*.mdx',
  '',
].join('\n');

const hub = (description: string, tags: string[] = ['caching', 'performance']) => ({
  description,
  intro: `${description}.`,
  tags,
});

/** Two top-level areas, one nested, three pages. */
export const STRUCTURE: Structure = {
  areas: [
    { id: 'patterns', label: 'Patterns', hub: hub('Reusable answers'), pages: [] },
    {
      id: 'caching',
      label: 'Caching',
      nestUnder: 'patterns',
      hub: hub('Keeping answers close'),
      pages: [
        { slug: 'alpha', label: 'Alpha', source: 'docs/patterns/caching/alpha.md', route: '/patterns/caching/alpha.html' },
        { slug: 'beta', label: 'Beta', source: 'docs/patterns/caching/beta.md' },
      ],
    },
    {
      id: 'hazards',
      label: 'Hazards',
      hub: hub('What goes wrong', ['resilience', 'caching']),
      pages: [{ slug: 'gamma', label: 'Gamma', source: 'docs/hazards/gamma.md' }],
    },
  ],
};

/** A published page's frontmatter: the six required keys, then the rest. */
export function frontmatter(title: string, extra: Record<string, string> = {}): string {
  const keys: Record<string, string> = {
    title,
    description: `What ${title} does`,
    area: 'caching',
    owner: 'Oleksandr Derechei',
    tags: '[caching, performance]',
    status: 'stable',
    ...extra,
  };
  return ['---', ...Object.entries(keys).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
}

/** The tag file, with a topic facet so a hub can group. */
export const TAGS_JSON = `${JSON.stringify(
  {
    version: 1,
    updated: '2026-09-24',
    note: 'Fixture tags.',
    facets: { topic: 't', skill: 's', language: 'l' },
    terms: [
      { id: 'caching', facet: 'topic', label: 'Caching topic', definition: 'd' },
      { id: 'resilience', facet: 'topic', definition: 'd' },
      { id: 'performance', facet: 'skill', definition: 'd' },
    ],
  },
  null,
  2,
)}\n`;

/** The glossary, one term: the search payload pass fails a build without one. */
export const GLOSSARY_JSON = `${JSON.stringify(
  {
    version: 1,
    updated: '2026-09-24',
    note: 'Fixture glossary.',
    terms: [{ id: 'breaker', term: 'Circuit breaker', definition: 'Stops the calls to a failing dependency.', aliases: [] }],
  },
  null,
  2,
)}\n`;

/** The published tree: structure, tags, the ignore rules and three pages. */
export function docsTree(sb: Sandbox, structure: Structure = STRUCTURE): void {
  sb.write('.gitignore', SITE_GITIGNORE);
  sb.write('docs/data/site-structure.json', `${JSON.stringify(structure, null, 2)}\n`);
  sb.write('docs/data/tags.json', TAGS_JSON);
  sb.write(
    'docs/patterns/caching/alpha.md',
    `${frontmatter('Alpha')}\n# Alpha\n\nAlpha keeps answers. See [Beta](./beta.md#why) and [Gamma](../../hazards/gamma.md).\n`,
  );
  sb.write('docs/patterns/caching/beta.md', `${frontmatter('Beta', { tags: '[resilience]' })}\n# Beta\n\nBeta.\n`);
  sb.write('docs/hazards/gamma.md', `${frontmatter('Gamma', { area: 'hazards' })}\n# Gamma\n\nGamma.\n`);
}

/** One built page after the post-build passes: relative links, facts on class-free blocks. */
export interface BuiltPage {
  readonly route: string;
  readonly title: string;
  readonly area: string;
  readonly tags?: string;
  /** The article's inner markup. */
  readonly body: string;
}

export function builtPage(p: BuiltPage): string {
  const depth = p.route.split('/').length - 2;
  const up = depth === 0 ? './' : '../'.repeat(depth);
  const tags = p.tags ?? 'caching,performance';
  const home = p.route === '/index.html';
  return [
    '<!doctype html>',
    '<html lang="en" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${p.title} | KB</title>`,
    `<meta name="description" content="What ${p.title} does">`,
    `<meta name="kb:area" content="${p.area}">`,
    '<meta name="kb:status" content="stable">',
    '<meta name="kb:owner" content="Oleksandr Derechei">',
    `<meta name="kb:tags" content="${tags}">`,
    `<script type="application/ld+json" data-kb="page">{"@context":"https://schema.org","@type":"TechArticle","headline":"${p.title}"}</script>`,
    `<link rel="stylesheet" href="${up}_astro/style.fixture.css">`,
    `<noscript><style>${NOSCRIPT_STYLE}</style></noscript>`,
    `<script src="${up}kb.js" defer data-kb="bundle"></script>`,
    '</head>',
    '<body class="frame">',
    '<a class="sl-skip-link" href="#_top" data-kb-skip>Skip to content</a>',
    `<header class="header" data-kb-skip><a href="${up}index.html">KB</a></header>`,
    '<main class="main">',
    home ? '' : `<nav class="kb-breadcrumbs" data-kb-skip><a href="${up}index.html">Home</a></nav>`,
    `<div data-page-head><h1 id="_top">${p.title}</h1><p class="kb-page-intro">What ${p.title} does</p></div>`,
    '<div class="sl-markdown-content" data-kb-region>',
    `<article data-page="${p.route}" data-area="${p.area}" data-tags="${tags}">${p.body}</article>`,
    '</div>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The pages of the built fixture site: home, three hubs, three pages. */
export const BUILT: readonly BuiltPage[] = [
  {
    route: '/index.html',
    title: 'KB',
    area: 'patterns',
    body: '<p>Start at <a href="./patterns.html">Patterns</a> or <a href="./hazards.html">Hazards</a>.</p>',
  },
  { route: '/patterns.html', title: 'Patterns', area: 'patterns', body: '<p><a href="./patterns/caching.html">Caching</a></p>' },
  {
    route: '/patterns/caching.html',
    title: 'Caching',
    area: 'caching',
    body: '<ol><li><a href="./caching/alpha.html">Alpha</a></li><li><a href="./caching/beta.html">Beta</a></li></ol>',
  },
  {
    route: '/patterns/caching/alpha.html',
    title: 'Alpha',
    area: 'caching',
    body:
      '<section data-block="description"><h2 id="description">What it is</h2><p id="description-p-1">Alpha.</p>' +
      '<p data-note="deeper" id="description-p-2">Deeper. <a href="../../index.html">Home</a></p>' +
      '<table><tbody><tr id="mapping-row-1"><th scope="row">Row</th><td>x</td></tr></tbody></table></section>',
  },
  { route: '/patterns/caching/beta.html', title: 'Beta', area: 'caching', body: '<p>Beta.</p>' },
  { route: '/hazards.html', title: 'Hazards', area: 'hazards', body: '<p><a href="./hazards/gamma.html">Gamma</a></p>' },
  { route: '/hazards/gamma.html', title: 'Gamma', area: 'hazards', body: '<p>Gamma.</p>' },
];

/**
 * A built site in the post-build shape: every page of `BUILT`, the manifest,
 * a search payload covering every page but the hubs, and the bundle — clean
 * for the portability, data-layer and built-links gates.
 */
export function builtSite(sb: Sandbox, dist = 'site/dist'): void {
  sb.write('docs/data/site-structure.json', `${JSON.stringify(STRUCTURE, null, 2)}\n`);
  sb.write('docs/data/glossary.json', GLOSSARY_JSON);
  for (const p of BUILT) sb.write(`${dist}${p.route}`, builtPage(p));
  const hubs = new Set(['/patterns.html', '/patterns/caching.html', '/hazards.html']);
  const manifest = BUILT.map((p) => ({
    route: p.route,
    title: p.title,
    description: `What ${p.title} does`,
    area: p.area,
    status: 'stable',
    tags: (p.tags ?? 'caching,performance').split(','),
    // Alpha states the two lists search ranks by; the others, as an older
    // manifest would, carry neither.
    ...(p.title === 'Alpha' ? { aliases: ['First'], solves: ['my answers, kept far away'] } : {}),
    headings: p.title === 'Alpha' ? [{ depth: 2, id: 'description', text: 'What it is' }] : [],
  }));
  sb.write(`${dist}/index.json`, `${JSON.stringify({ generator: 'fixture', pages: manifest }, null, 2)}\n`);
  const payload = manifest.filter((p) => !hubs.has(p.route));
  sb.write(`${dist}/search-index.js`, `window.kb = ${JSON.stringify({ pages: payload, terms: [] })};\n`);
  // The bundle names the payload it loads when the search box opens, which is
  // how the reachability walk finds search-index.js.
  sb.write(`${dist}/kb.js`, 'var payload = "search-index.js";\n');
  sb.write(`${dist}/_astro/style.fixture.css`, ':root { color-scheme: light dark; }\n');
  // Each page-tree page's source, and the copy the post-build pass ships beside its page.
  for (const area of STRUCTURE.areas) {
    const folder = area.nestUnder === undefined ? area.id : `${area.nestUnder}/${area.id.replace(`${area.nestUnder}-`, '')}`;
    for (const row of area.pages) {
      const route = row.route ?? `/${folder}/${row.slug}.html`;
      if (!sb.exists(row.source)) sb.write(row.source, `${frontmatter(row.label)}\n# ${row.label}\n`);
      sb.write(`${dist}${route.replace(/\.html$/, '.md')}`, sb.read(row.source));
    }
  }
}

/** One row of a page's relationships block, as the generator writes it. */
export interface RawRelation {
  /** The heading the row sits under. */
  readonly group: string;
  /** The route of the page it links, root-absolute. */
  readonly route: string;
  /** The link's text: the title of the page it links. */
  readonly title: string;
  /** The words after the link; none when empty. */
  readonly note: string;
}

/** One page as Astro hands it to the post-build passes: root-absolute links, no article block, the head's facts. */
export interface RawPage {
  readonly route: string;
  readonly title: string;
  readonly description: string;
  readonly area: string;
  readonly owner: string;
  /** The page has a markdown source beside it, so its head links it (Head.astro). */
  readonly markdown: boolean;
  /** The page is a page of the knowledge base, so its head links its record (Head.astro). */
  readonly record: boolean;
  /** Where the page sits when it is a page of the knowledge base, so its head states it (Head.astro); none otherwise. */
  readonly place?: { readonly kind: string; readonly band: string; readonly group: string };
  /** The rows of the page's relationships block, in the order the block shows them; the block is left out when there are none. */
  readonly relations?: readonly RawRelation[];
}

/** `rawPage`'s two discovery links, as Head.astro writes them before the pass makes them relative. */
export function rawAlternates(route: string, which: { readonly markdown: boolean; readonly record: boolean }): string[] {
  const at = (ext: string): string => route.replace(/\.html$/, ext);
  return [
    ...(which.markdown ? [`<link rel="alternate" type="text/markdown" href="${at('.md')}">`] : []),
    ...(which.record ? [`<link rel="alternate" type="application/json" href="${at('.json')}">`] : []),
  ];
}

/** Text as it sits in markup: the three characters that would start a tag or a reference. */
const markup = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The relationships block of a page as Astro hands it to the passes: the
 * heading with the section fact that makes it a block, then the generated
 * region, one paragraph and one list for each run of rows under the same
 * heading. Nothing for a page with no rows.
 */
export function rawRelationships(rows: readonly RawRelation[]): string {
  const groups: { readonly label: string; readonly rows: RawRelation[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === row.group) last.rows.push(row);
    else groups.push({ label: row.group, rows: [row] });
  }
  if (groups.length === 0) return '';
  const item = (r: RawRelation): string => `<li><a href="${r.route}">${markup(r.title)}</a>${r.note === '' ? '' : ` — ${markup(r.note)}`}</li>`;
  return [
    '<div class="sl-heading-wrapper level-h2"><h2 id="relationships">How it relates</h2></div>',
    '<!--meta block=relationships-->',
    '<!-- relationships:start -->',
    '<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->',
    ...groups.map((g, i) => `<p id="relationships-p-${String(i + 1)}"><strong>${markup(g.label)}</strong></p><ul>${g.rows.map(item).join('')}</ul>`),
    '<!-- relationships:end -->',
  ].join('\n');
}

/** The markup of a page before the post-build passes: what the passes read, with the skip link and the region they expect. */
export function rawPage(p: RawPage): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${p.title} | KB</title>`,
    `<meta name="description" content="${p.description}">`,
    `<meta name="kb:area" content="${p.area}"><meta name="kb:owner" content="${p.owner}">`,
    ...(p.place === undefined
      ? []
      : [`<meta name="kb:kind" content="${p.place.kind}"><meta name="kb:band" content="${p.place.band}"><meta name="kb:group" content="${p.place.group}">`]),
    ...rawAlternates(p.route, p),
    `<script type="application/ld+json" data-kb="page">{"headline":"${p.title}"}</script>`,
    '</head><body><a class="sl-skip-link" href="#_top">Skip to content</a>',
    `<div data-page-head><h1 id="_top">${p.title}</h1></div>`,
    `<div class="sl-markdown-content" data-kb-region><p>${p.description}</p>${rawRelationships(p.relations ?? [])}</div>`,
    '</body></html>',
    '',
  ].join('\n');
}

/**
 * The knowledge-base fixture tree of the page record (`writeRecordFixture`),
 * with the schemas the repo publishes, and a raw page for each of its pages:
 * the twelve pages of the knowledge base, each stating where it sits and
 * showing the relationships block its record lists, a reference page that has
 * a markdown source and no record, and the home page, which has neither. Run
 * the post-build pass over it and the search payload pass after it, and it is
 * a built site.
 */
export function rawKbSite(sb: Sandbox, dist = 'site/dist'): void {
  writeRecordFixture(sb.dir);
  sb.write('docs/data/glossary.json', GLOSSARY_JSON);
  sb.copyRepo(SCHEMA_DIR);
  const corpus = new Corpus(sb.dir);
  const owner = 'Test Owner';
  for (const page of corpus.listing) {
    const meta = corpus.meta(page.slug);
    const relations = recordOf(corpus, page.slug).relations.map((r) => ({ group: r.group, route: r.route, title: r.title, note: r.note.text }));
    sb.write(
      `${dist}${page.route}`,
      rawPage({
        route: page.route,
        title: meta.title,
        description: meta.essence,
        area: page.area,
        owner,
        markdown: true,
        record: true,
        place: { kind: page.kind, band: page.band, group: page.group },
        relations,
      }),
    );
  }
  sb.write(`${dist}/reference/notes.html`, rawPage({ route: '/reference/notes.html', title: 'Notes', description: 'Not a page of any kind', area: 'reference', owner, markdown: true, record: false }));
  sb.write(`${dist}/index.html`, rawPage({ route: '/index.html', title: 'KB', description: 'The home page', area: 'patterns', owner, markdown: false, record: false }));
}

/** Upstream script files the real build loads, as the fixture names them; each is a classic script. */
const UPSTREAM_SCRIPTS = {
  classic: ['_astro/sl-theme.f1.js'],
  deferred: ['_astro/starlight.f1.js'],
  code: '_astro/ec.f1.js',
} as const;

/**
 * `html` carrying what the real build adds besides ours, spread across pages
 * the way the build spreads it: Starlight's chrome scripts and the print
 * stylesheet on every page, and the code-block script and stylesheet on Alpha;
 * `carry` says whether a page holds them, for a site of one page. Every entry of the absence gate's lists then
 * matches something, as it does on the real site.
 */
export function withUpstream(
  html: string,
  route: string,
  carry: { code?: boolean } = { code: route.endsWith('/alpha.html') },
): string {
  const depth = route.split('/').length - 2;
  const up = depth === 0 ? './' : '../'.repeat(depth);
  const head = [
    ...UPSTREAM_SCRIPTS.classic.map((f) => `<script src="${up}${f}"></script>`),
    ...UPSTREAM_SCRIPTS.deferred.map((f) => `<script src="${up}${f}" defer></script>`),
    `<link rel="stylesheet" href="${up}_astro/print.f1.css" media="print">`,
    ...(carry.code === true
      ? [`<script src="${up}${UPSTREAM_SCRIPTS.code}" defer></script>`, `<link rel="stylesheet" href="${up}_astro/ec.f1.css">`]
      : []),
  ].join('\n');
  return html.replace('</head>', `${head}\n</head>`);
}

/** The files `withUpstream` points at, under `dist`. */
export function upstreamFiles(sb: Sandbox, dist = 'site/dist'): void {
  for (const f of [...UPSTREAM_SCRIPTS.classic, ...UPSTREAM_SCRIPTS.deferred, UPSTREAM_SCRIPTS.code]) sb.write(`${dist}/${f}`, '/* upstream */\n');
  sb.write(`${dist}/_astro/print.f1.css`, '@media print { nav { display: none; } }\n');
  sb.write(`${dist}/_astro/ec.f1.css`, '.expressive-code { display: block; }\n');
}

/**
 * `builtSite` with the upstream extras, at the formatter's fixed point, as
 * the build's last step leaves it: the shape the absence gate reads (spec
 * kb.noise.formatter).
 */
export function formattedSite(sb: Sandbox, dist = 'site/dist'): void {
  builtSite(sb, dist);
  upstreamFiles(sb, dist);
  for (const p of BUILT) sb.write(`${dist}${p.route}`, formatHtml(withUpstream(builtPage(p), p.route)));
}
