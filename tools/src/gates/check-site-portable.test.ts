/**
 * The portability gate over a built site (spec kb.site.offline), and the
 * post-build passes over a home page and a page one folder down. offline-O1
 * itself runs a real build: tools/src/site/site-sandbox.test.ts.
 *
 * Check 8, the files of the retrieval contract, is held over a built
 * knowledge-base fixture: the post-build pass makes the site once, a copy of it
 * is edited for each way a file can be wrong, and the gate names that file.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_DIR } from '../contract/contract.js';
import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { spec as payloadPass } from '../site/gen-search-index.js';
import { BUILT, builtPage, builtSite, GLOSSARY_JSON, rawKbSite } from '../site/site-fixtures.js';
import { spec as portablePass } from '../site/site-portable.js';
import { lineIndex, parsePayload, readTags, SCHEMA_FINDINGS_SHOWN, spec } from './check-site-portable.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe('the post-build passes over Astro-shaped pages', () => {
  it('make a home page and a page one folder down link each other relatively, open from disk, and the gate exits 0', async () => {
    sb.write('docs/data/glossary.json', GLOSSARY_JSON);
    sb.write(
      'docs/data/site-structure.json',
      JSON.stringify({
        areas: [
          {
            id: 'patterns',
            label: 'Patterns',
            hub: { description: 'd', intro: 'i', tags: [] },
            pages: [{ slug: 'alpha', label: 'Alpha', source: 'docs/patterns/alpha.md', route: '/patterns/alpha.html' }],
          },
        ],
      }),
    );
    // What Astro hands the post-build passes: root-absolute links, no article block.
    const raw = (title: string, body: string): string =>
      [
        '<!doctype html><html><head>',
        `<meta name="kb:area" content="patterns"><meta name="kb:owner" content="Oleksandr Derechei">`,
        `<script type="application/ld+json" data-kb="page">{"headline":"${title}"}</script>`,
        '<script src="/search-index.js" defer data-kb="search-index"></script><script src="/kb.js" defer data-kb="bundle"></script>',
        '</head><body><a class="sl-skip-link" href="#_top">Skip to content</a>',
        `<div data-page-head><h1 id="_top">${title}</h1></div>`,
        `<div class="sl-markdown-content" data-kb-region>${body}</div>`,
        '</body></html>',
        '',
      ].join('\n');
    sb.write('docs/patterns/alpha.md', '---\ntitle: Alpha\n---\n\n# Alpha\n');
    sb.write('site/dist/index.html', raw('Home', '<p>Go to <a href="/patterns/alpha.html">Alpha</a>.</p>'));
    sb.write('site/dist/patterns/alpha.html', raw('Alpha', '<p>Back <a href="/">home</a>.</p>'));
    sb.write('site/dist/kb.js', '"use strict";\n');

    expectPass(await sb.run(portablePass));
    expectPass(await sb.run(payloadPass));

    const home = sb.read('site/dist/index.html');
    const alpha = sb.read('site/dist/patterns/alpha.html');
    expect(home).toContain('<a href="./patterns/alpha.html">Alpha</a>');
    expect(alpha).toContain('<a href="../index.html">home</a>');
    // Every internal link and source resolves to a real file on disk, the way
    // a browser reading the folder resolves it.
    for (const [file, html] of [
      ['site/dist/index.html', home],
      ['site/dist/patterns/alpha.html', alpha],
    ] as const) {
      for (const m of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
        const target = path.resolve(path.dirname(path.join(sb.dir, file)), m[1] as string);
        expect(fs.existsSync(target), `${file} → ${m[1] as string}`).toBe(true);
      }
    }
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out.split('\n')).toHaveLength(1);
  });
});

describe('check-site-portable', () => {
  it('passes a clean built site with one summary line', async () => {
    builtSite(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(`[site-portable] ${BUILT.length} pages portable, indexed, anchored and keyboard-reachable; index.json and search-index.js present; 3 markdown sources match docs/`);
  });

  it('names a page-tree page whose markdown is missing or differs from its source, and a markdown file no page owns', async () => {
    builtSite(sb);
    sb.rm('site/dist/patterns/caching/alpha.md');
    sb.write('site/dist/hazards/gamma.md', 'edited');
    sb.write('site/dist/stray.md', 'x');
    sb.write('site/dist/patterns/caching.md', 'hub');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('site/dist/patterns/caching/alpha.md: is missing');
    expect(r.err).toContain('site/dist/hazards/gamma.md: differs from docs/hazards/gamma.md');
    expect(r.err).toContain('site/dist/stray.md: is a markdown file no page-tree page owns');
    expect(r.err).toContain('site/dist/patterns/caching.md: is a markdown file no page-tree page owns');
    expect(r.err.split('\n')).toHaveLength(4);
  });

  it('expects no markdown beside a page a generator writes, and names one that ships there', async () => {
    builtSite(sb);
    const structure = JSON.parse(sb.read('docs/data/site-structure.json')) as { areas: { id: string; pages: { source: string }[] }[] };
    (structure.areas.find((a) => a.id === 'hazards') as (typeof structure.areas)[number]).pages[0]!.source = 'generated';
    sb.write('docs/data/site-structure.json', JSON.stringify(structure));
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toBe('[site-portable] FAIL site/dist/hazards/gamma.md: is a markdown file no page-tree page owns — only a page-tree page ships its source');
  });

  it('names a built page-tree page whose source file is gone', async () => {
    builtSite(sb);
    sb.rm('docs/hazards/gamma.md');
    expectFail(await sb.run(spec), 'site/dist/hazards/gamma.html: its source docs/hazards/gamma.md is not in the repository');
  });

  it('names a root-absolute reference and a positive tabindex at their lines', async () => {
    builtSite(sb);
    const file = 'site/dist/patterns/caching/beta.html';
    sb.write(file, sb.read(file).replace('<p>Beta.</p>', '<p>Beta.</p>\n<a href="/x.html" tabindex="3">x</a>'));
    const r = await sb.run(spec);
    expectFail(r);
    const line = sb.read(file).split('\n').findIndex((l) => l.includes('href="/x.html"')) + 1;
    expect(r.err).toContain(`[site-portable] FAIL ${file}:${line}: root-absolute reference href="/x.html"`);
    expect(r.err).toContain(`[site-portable] FAIL ${file}:${line}: positive tabindex tabindex="3"`);
  });

  it('names a diagram click link left root-absolute', async () => {
    builtSite(sb);
    const file = 'site/dist/patterns/caching/beta.html';
    sb.write(file, sb.read(file).replace('<p>Beta.</p>', '<p>Beta.</p>\n<svg id="mermaid-0"><a xlink:href="/hazards/gamma.html"><text>G</text></a></svg>'));
    const r = await sb.run(spec);
    expectFail(r);
    const line = sb.read(file).split('\n').findIndex((l) => l.includes('xlink:href')) + 1;
    expect(r.err).toBe(
      `[site-portable] FAIL ${file}:${line}: root-absolute reference xlink:href="/hazards/gamma.html" — the post-build pass makes links relative; run make site-build`,
    );
  });

  it('names a root-absolute reference in any quoting, at its line, and never one inside an attribute value', async () => {
    builtSite(sb);
    const file = 'site/dist/patterns/caching/beta.html';
    sb.write(
      file,
      sb
        .read(file)
        .replace(
          '<p>Beta.</p>',
          `<p>Beta.</p>\n<a href='/patterns.html'>p</a>\n<img src=/favicon.svg alt=x>\n<button data-code='<a href="/in-code.html">'>c</button>`,
        ),
    );
    const r = await sb.run(spec);
    expectFail(r);
    const lines = sb.read(file).split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
    expect(r.err.split('\n')).toEqual([
      `[site-portable] FAIL ${file}:${at("href='/patterns.html'")}: root-absolute reference href="/patterns.html" — the post-build pass makes links relative; run make site-build`,
      `[site-portable] FAIL ${file}:${at('src=/favicon.svg')}: root-absolute reference src="/favicon.svg" — the post-build pass makes links relative; run make site-build`,
    ]);
  });

  it('names every finding from the repository root, however --dist is written', async () => {
    builtSite(sb);
    const file = 'site/dist/patterns/caching/beta.html';
    sb.write(file, sb.read(file).replace('<p>Beta.</p>', '<p>Beta.</p>\n<a href="x.html" tabindex="3">x</a>'));
    const line = sb.read(file).split('\n').findIndex((l) => l.includes('tabindex="3"')) + 1;
    const want = `[site-portable] FAIL ${file}:${line}: positive tabindex tabindex="3" reorders the keyboard walk`;
    for (const dist of [path.join(sb.dir, 'site/dist'), './site/dist/', 'site/dist']) {
      const r = await sb.run(spec, ['--dist', dist]);
      expectFail(r);
      expect(r.err, dist).toBe(want);
    }
  });

  it('names an injected module, a page with no area, and a page with no skip link', async () => {
    builtSite(sb);
    const file = 'site/dist/hazards/gamma.html';
    sb.write(
      file,
      sb
        .read(file)
        .replace('<meta name="kb:area" content="hazards">', '')
        .replace('<a class="sl-skip-link" href="#_top" data-kb-skip>Skip to content</a>', '')
        .replace('defer data-kb="bundle"', 'type="module" data-kb="bundle"'),
    );
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain(`${file}: a <script type="module"> carrying data-kb`);
    expect(r.err).toContain(`${file}: no <meta name="kb:area"`);
    expect(r.err).toContain(`${file}: no skip link`);
  });

  it('reads the area by the attributes a meta element has, in any order or quoting', async () => {
    builtSite(sb);
    const file = 'site/dist/hazards/gamma.html';
    sb.write(file, sb.read(file).replace('<meta name="kb:area" content="hazards">', '<meta content=hazards name="kb:area">'));
    expectPass(await sb.run(spec));
    sb.write(file, sb.read(file).replace('<meta content=hazards name="kb:area">', '<meta name="kb:area" content>'));
    expectFail(await sb.run(spec), `${file}: no <meta name="kb:area"`);
  });

  it('names a missing or empty manifest and payload, and checks no coverage then', async () => {
    builtSite(sb);
    sb.rm('site/dist/index.json');
    sb.write('site/dist/search-index.js', '');
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('site/dist/index.json: is missing or empty');
    expect(r.err).toContain('site/dist/search-index.js: is missing or empty');
    expect(r.err.split('\n')).toHaveLength(2);
  });

  it('names a payload that is gone, where an unhashed one would be', async () => {
    builtSite(sb);
    sb.rm('site/dist/search-index.js');
    expectFail(await sb.run(spec), 'site/dist/search-index.js: is missing or empty');
  });

  it('refuses a payload that is not one window.kb assignment', async () => {
    builtSite(sb);
    sb.write('site/dist/search-index.js', 'window.kb = 1; alert(1);\n');
    expectFail(await sb.run(spec), 'is not one `window.kb = {…};` assignment');
  });

  it('names a page search cannot find, an indexed route with no page, and an anchor with no element', async () => {
    builtSite(sb);
    sb.write(
      'site/dist/search-index.js',
      `window.kb = ${JSON.stringify({
        pages: [
          { route: '/index.html', headings: [] },
          { route: '/patterns/caching/alpha.html', headings: [{ id: 'description', text: 'x' }, { id: 'gone', text: 'y' }, { id: '', text: 'z' }] },
          { route: '/hazards/gamma.html', headings: [] },
          { route: '/nowhere.html', headings: [] },
        ],
        terms: [],
      })};\n`,
    );
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err).toContain('site/dist/patterns/caching/beta.html: is a built page search cannot find');
    expect(r.err).toContain('site/dist/search-index.js: indexes /nowhere.html, and no such page was built');
    expect(r.err).toContain('site/dist/search-index.js: offers /patterns/caching/alpha.html#gone');
    expect(r.err.split('\n')).toHaveLength(3);
  });

  it('holds a payload anchor to a real id: a diagram edge’s data-id, or an id a code sample shows, is none', async () => {
    builtSite(sb);
    const file = 'site/dist/patterns/caching/alpha.html';
    sb.write(file, sb.read(file).replace('</article>', '<svg><path data-id="L_Caller_Gate_0"></path></svg><pre><code id="in-code"></code></pre></article>'));
    const payload = parsePayload(sb.read('site/dist/search-index.js').trim()) as { pages: { route: string; headings: { id: string; text: string }[] }[] };
    const page = payload.pages.find((p) => p.route === '/patterns/caching/alpha.html') as (typeof payload.pages)[number];
    page.headings.push({ id: 'L_Caller_Gate_0', text: 'edge' }, { id: 'in-code', text: 'code' });
    sb.write('site/dist/search-index.js', `window.kb = ${JSON.stringify({ ...payload, terms: [] })};\n`);
    const r = await sb.run(spec);
    expectFail(r);
    expect(r.err.split('\n')).toEqual([
      '[site-portable] FAIL site/dist/search-index.js: offers /patterns/caching/alpha.html#L_Caller_Gate_0, and that page has no element with that id',
      '[site-portable] FAIL site/dist/search-index.js: offers /patterns/caching/alpha.html#in-code, and that page has no element with that id',
    ]);
  });

  it('asks for a build when there is no built site, an empty one, or --dist is empty', async () => {
    builtSite(sb, 'elsewhere');
    expectFail(await sb.run(spec), 'no built site at site/dist — build it first: make site-build');
    expectFail(await sb.run(spec, ['--dist', '']), "no built site at ''");
    sb.mkdir('empty');
    expectFail(await sb.run(spec, ['--dist', 'empty']), 'no .html files under empty');
    expectPass(await sb.run(spec, ['--dist', 'elsewhere']));
  });

  it('exits 2 on an unknown flag, writing nothing', async () => {
    builtSite(sb);
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['--nope']));
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('check-site-portable, check 8: the files of the retrieval contract', () => {
  let base: Sandbox;
  beforeAll(async () => {
    base = makeSandbox();
    rawKbSite(base);
    expectPass(await base.run(portablePass));
    expectPass(await base.run(payloadPass));
  }, 120_000);
  afterAll(() => base.cleanup());

  /** A copy of the built fixture site in the test's own sandbox, `.git` apart, for the test to edit. */
  beforeEach(() => {
    fs.cpSync(base.dir, sb.dir, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  });

  const DIR = 'patterns/distributed/resilience';
  const DIST = 'site/dist';
  const BREAKER_HTML = `${DIST}/${DIR}/breaker.html`;
  const BREAKER_JSON = `${DIST}/${DIR}/breaker.json`;
  const INDEX = `${DIST}/index.json`;
  const found = (r: { err: string }): string[] => r.err.trim().split('\n');
  const FAIL = '[site-portable] FAIL ';

  type Index = { pages: Record<string, unknown>[] } & Record<string, unknown>;
  /** `edit` applied to the built index, written back as the pass writes it. */
  const editIndex = (edit: (index: Index) => void): void => {
    const index = JSON.parse(sb.read(INDEX)) as Index;
    edit(index);
    sb.write(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  };
  const entryOf = (index: Index, route: string): Record<string, unknown> => index.pages.find((p) => p['route'] === route) as Record<string, unknown>;

  it('passes the built knowledge base, and says how many records, and which files, it held to the repo', async () => {
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe(
      '[site-portable] 14 pages portable, indexed, anchored and keyboard-reachable; index.json and search-index.js present; 13 markdown sources match docs/; ' +
        '12 records, graph.json, llms.txt, llms-full.txt and 4 schemas match the knowledge base',
    );
  });

  it('checks nothing of it in a tree that has no content model, and says nothing of it', async () => {
    sb.rm('docs/data/content-model.json');
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toBe('[site-portable] 14 pages portable, indexed, anchored and keyboard-reachable; index.json and search-index.js present; 13 markdown sources match docs/');
  });

  it('names a page of the knowledge base whose record cannot be built, by its markdown', async () => {
    const md = 'docs/patterns/distributed/resilience/breaker.md';
    sb.write(md, sb.read(md).replace('<!-- relationships:end -->', ''));
    const r = await sb.run(spec);
    expectFail(r);
    expect(found(r)).toContain(`${FAIL}${md}: its record cannot be built: breaker: the region "relationships" is never closed`);
  });

  describe('the records', () => {
    it('names a record that is missing, and the page it belongs to', async () => {
      sb.rm(BREAKER_JSON);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([`${FAIL}${BREAKER_JSON}: is missing — site-portable writes it; run make site-build`]);
    });

    it('names a record that is not what `kb.mjs record` prints, in any byte', async () => {
      sb.write(BREAKER_JSON, sb.read(BREAKER_JSON).replace('"title": "Breaker"', '"title": "Breaker "'));
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([`${FAIL}${BREAKER_JSON}: differs from what \`kb.mjs record breaker\` prints — run make site-build`]);
    });

    it('names a record with its last newline gone', async () => {
      sb.write(BREAKER_JSON, sb.read(BREAKER_JSON).trimEnd());
      expectFail(await sb.run(spec), 'breaker.json: differs from what `kb.mjs record breaker` prints');
    });

    it('names a .json file that no entry of the index lists as a record, beside a page or anywhere else', async () => {
      sb.write(`${DIST}/${DIR}/stray.json`, '{}\n');
      sb.write(`${DIST}/reference/notes.json`, '{}\n');
      sb.write(`${DIST}/old/deep/x.json`, '{}\n');
      const r = await sb.run(spec);
      expectFail(r);
      const why = 'is a JSON file no entry of index.json lists as its record — only a page of the knowledge base ships one';
      expect(found(r)).toEqual([`${FAIL}${DIST}/old/deep/x.json: ${why}`, `${FAIL}${DIST}/${DIR}/stray.json: ${why}`, `${FAIL}${DIST}/reference/notes.json: ${why}`]);
    });
  });

  describe('the graph and the schemas', () => {
    it('names a graph that is missing, and one that is not what `kb.mjs graph` prints', async () => {
      const graph = `${DIST}/graph.json`;
      const text = sb.read(graph);
      sb.rm(graph);
      // llms.txt links the graph, so a graph that is not there is a dead link too.
      expect(found(await sb.run(spec))).toEqual([
        `${FAIL}${graph}: is missing — site-portable writes it; run make site-build`,
        `${FAIL}${DIST}/llms.txt: links graph.json, and no such file was built`,
      ]);
      sb.write(graph, text.replace('"contract": "kb-graph/1"', '"contract": "kb-graph/2"'));
      expect(found(await sb.run(spec))).toEqual([`${FAIL}${graph}: differs from what \`kb.mjs graph\` prints — run make site-build`]);
    });

    it('names a schema copy that is missing or edited, and a file in schema/ the repo does not publish', async () => {
      sb.rm(`${DIST}/schema/kb-record-1.json`);
      sb.write(`${DIST}/schema/kb-graph-1.json`, '{}\n');
      sb.write(`${DIST}/schema/kb-extra-1.json`, '{}\n');
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/schema/kb-graph-1.json: differs from ${SCHEMA_DIR}/kb-graph-1.json — run make site-build`,
        `${FAIL}${DIST}/schema/kb-record-1.json: is missing — site-portable writes it; run make site-build`,
        `${FAIL}${DIST}/schema/kb-extra-1.json: is no file of ${SCHEMA_DIR} — only those are published`,
        `${FAIL}${DIST}/llms.txt: links schema/kb-record-1.json, and no such file was built`,
      ]);
    });

    it('names every schema when the schema folder is gone, and each link of llms.txt into it', async () => {
      sb.rm(`${DIST}/schema`);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        ...['kb-cli-1', 'kb-graph-1', 'kb-index-1', 'kb-record-1'].map((name) => `${FAIL}${DIST}/schema/${name}.json: is missing — site-portable writes it; run make site-build`),
        ...['kb-record-1', 'kb-index-1', 'kb-graph-1'].map((name) => `${FAIL}${DIST}/llms.txt: links schema/${name}.json, and no such file was built`),
      ]);
    });

    it('names a schema file the repo lacks, which index.json is held to, and the copy the site holds of it', async () => {
      sb.rm(`${SCHEMA_DIR}/kb-index-1.json`);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${SCHEMA_DIR}/kb-index-1.json: is missing — index.json is held to it`,
        `${FAIL}${DIST}/schema/kb-index-1.json: is no file of ${SCHEMA_DIR} — only those are published`,
      ]);
    });
  });

  describe('the index', () => {
    it('names an index that is not JSON, and checks no more of it', async () => {
      sb.write(INDEX, '{ "pages": [');
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toHaveLength(1);
      expect(found(r)[0]).toMatch(new RegExp(`^\\[site-portable\\] FAIL ${INDEX}: is not valid JSON — `));
    });

    it('holds the index to the closed form of kb-index-1: a key it does not list is a finding', async () => {
      editIndex((index) => {
        index['extra'] = 1;
        entryOf(index, '/index.html')['extra'] = true;
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${INDEX}: breaks kb-index-1: /: must NOT have additional property "extra" (additionalProperties)`,
        `${FAIL}${INDEX}: breaks kb-index-1: /pages/0: must NOT have additional property "extra" (additionalProperties)`,
      ]);
    });

    it('writes out five ways the index breaks its schema, and counts the rest', async () => {
      editIndex((index) => {
        for (const p of index.pages.slice(0, SCHEMA_FINDINGS_SHOWN + 2)) delete p['owner'];
      });
      const r = await sb.run(spec);
      expectFail(r);
      const lines = found(r);
      expect(lines).toHaveLength(SCHEMA_FINDINGS_SHOWN + 1);
      expect(lines.slice(0, SCHEMA_FINDINGS_SHOWN)).toEqual(
        [0, 1, 2, 3, 4].map((i) => `${FAIL}${INDEX}: breaks kb-index-1: /pages/${String(i)}: must have required property 'owner' (required)`),
      );
      expect(lines[SCHEMA_FINDINGS_SHOWN]).toBe(`${FAIL}${INDEX}: breaks kb-index-1 in 2 more place(s)`);
    });

    it('names a page of the knowledge base that the index gives another kind, and each of its five fields that is not the record’s', async () => {
      editIndex((index) => {
        const entry = entryOf(index, `/${DIR}/breaker.html`);
        entry['kind'] = 'hazard';
        entry['band'] = null;
        entry['id'] = 'fuse';
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${INDEX}: /${DIR}/breaker.html: id is "fuse", the page's record says "breaker"`,
        `${FAIL}${INDEX}: /${DIR}/breaker.html: kind is "hazard", the page's record says "pattern"`,
        `${FAIL}${INDEX}: /${DIR}/breaker.html: band is null, the page's record says "distributed"`,
      ]);
    });

    it('names a page of the knowledge base the index has no entry for, and its record, which no entry lists now', async () => {
      editIndex((index) => {
        index.pages = index.pages.filter((p) => p['route'] !== `/${DIR}/breaker.html`);
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${INDEX}: has no entry for /${DIR}/breaker.html, a page of the knowledge base`,
        `${FAIL}${BREAKER_JSON}: is a JSON file no entry of index.json lists as its record — only a page of the knowledge base ships one`,
      ]);
    });

    it('names an entry of a page that is not of the knowledge base, naming a record of its own', async () => {
      editIndex((index) => {
        Object.assign(entryOf(index, '/index.html'), { id: 'home', record: '/graph.json' });
      });
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([`${FAIL}${INDEX}: /index.html: names id, record, but it is no page of the knowledge base`]);
    });
  });

  describe('llms.txt and llms-full.txt', () => {
    it('names an llms.txt that is missing, and an llms-full.txt', async () => {
      sb.rm(`${DIST}/llms.txt`);
      sb.rm(`${DIST}/llms-full.txt`);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/llms.txt: is missing — site-portable writes it; run make site-build`,
        `${FAIL}${DIST}/llms-full.txt: is missing — site-portable writes it; run make site-build`,
      ]);
    });

    it('names an llms.txt that is not what the build writes, and an llms-full.txt that is not the pages’ markdown', async () => {
      sb.write(`${DIST}/llms.txt`, `${sb.read(`${DIST}/llms.txt`)}\n`);
      sb.write(`${DIST}/llms-full.txt`, sb.read(`${DIST}/llms-full.txt`).replace('<!-- kb:page id=retry', '<!-- kb:page id=retr'));
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/llms.txt: differs from what site-records.ts builds from the pages — run make site-build`,
        `${FAIL}${DIST}/llms-full.txt: differs from the markdown of every page, each after its marker line — run make site-build`,
      ]);
    });

    it('names each link of llms.txt that opens no file, once, though the text differs too', async () => {
      sb.write(`${DIST}/llms.txt`, `${sb.read(`${DIST}/llms.txt`)}- [Ghost](ghost.md): x\n- [Again](ghost.md): y\n- [Up](../outside.md): z\n`);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/llms.txt: differs from what site-records.ts builds from the pages — run make site-build`,
        `${FAIL}${DIST}/llms.txt: links ghost.md, and no such file was built`,
        `${FAIL}${DIST}/llms.txt: links ../outside.md, and no such file was built`,
      ]);
    });

    it('names a link of llms.txt whose file was deleted, though llms.txt is the build’s', async () => {
      sb.rm(`${DIST}/${DIR}/breaker.md`);
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toContain(`${FAIL}${DIST}/llms.txt: links ${DIR}/breaker.md, and no such file was built`);
    });
  });

  describe('the discovery links', () => {
    /** The built page with `edit` applied to its text. */
    const edit = (file: string, change: (html: string) => string): void => {
      sb.write(file, change(sb.read(file)));
    };
    const MD_LINK = /<link rel="alternate" type="text\/markdown" href="[^"]*">\n?/;
    const JSON_LINK = /<link rel="alternate" type="application\/json" href="[^"]*">\n?/;

    it('has each page of the knowledge base link its markdown and its record', async () => {
      const html = sb.read(BREAKER_HTML);
      expect(html).toMatch(MD_LINK);
      expect(html).toMatch(JSON_LINK);
      expectPass(await sb.run(spec));
    });

    it('names a page of the knowledge base whose head lost its markdown link, or its record link', async () => {
      edit(BREAKER_HTML, (html) => html.replace(MD_LINK, ''));
      edit(`${DIST}/hazards/storm.html`, (html) => html.replace(JSON_LINK, ''));
      const r = await sb.run(spec);
      expectFail(r);
      // In the order the pages are read: by path, so hazards before patterns.
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/hazards/storm.html: its head has no <link rel="alternate" type="application/json"> to /hazards/storm.json — site/src/components/Head/Head.astro writes it`,
        `${FAIL}${BREAKER_HTML}: its head has no <link rel="alternate" type="text/markdown"> to /${DIR}/breaker.md — site/src/components/Head/Head.astro writes it`,
      ]);
    });

    it('names a link that points at another page’s file, as one missing and one that is no file of the page', async () => {
      edit(BREAKER_HTML, (html) => html.replace(/(<link rel="alternate" type="application\/json" href=")[^"]*"/, '$1../../../hazards/storm.json"'));
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${BREAKER_HTML}: its head has no <link rel="alternate" type="application/json"> to /${DIR}/breaker.json — site/src/components/Head/Head.astro writes it`,
        `${FAIL}${BREAKER_HTML}: its head links /hazards/storm.json as application/json, and that is no file of this page`,
      ]);
    });

    it('names a page that is no page of the knowledge base but links a record, and a page the tree has no markdown for that links markdown', async () => {
      edit(`${DIST}/reference/notes.html`, (html) => html.replace('</head>', '<link rel="alternate" type="application/json" href="../reference/notes.json">\n</head>'));
      edit(`${DIST}/index.html`, (html) => html.replace('</head>', '<link rel="alternate" type="text/markdown" href="./index.md">\n</head>'));
      const r = await sb.run(spec);
      expectFail(r);
      expect(found(r)).toEqual([
        `${FAIL}${DIST}/index.html: its head links /index.md as text/markdown, and that is no file of this page`,
        `${FAIL}${DIST}/reference/notes.html: its head links /reference/notes.json as application/json, and that is no file of this page`,
      ]);
    });

    it('lets a page link what is no business of the contract, and a link written twice', async () => {
      edit(BREAKER_HTML, (html) =>
        html.replace('</head>', '<link rel="alternate" type="application/rss+xml" href="../feed.xml">\n<link rel="alternate" type="text/markdown" href="../../../patterns/distributed/resilience/breaker.md">\n</head>'),
      );
      expectPass(await sb.run(spec));
    });
  });
});

describe('the tag reader', () => {
  it('reads a root-absolute reference, never a protocol-relative one', () => {
    expect(readTags('<a href="/x">\n<img src="/">\n<a href="//cdn/x">').rootAbsolute.map((h) => h.line)).toEqual([1, 2]);
  });

  it('reads only a positive tabindex', () => {
    expect(readTags('<a tabindex="0"><a tabindex="-1"><a tabindex=10>').positiveTabindex).toEqual([{ line: 1, what: 'tabindex="10"' }]);
  });

  it('finds our module script and the skip link by their attributes, in any order or quoting', () => {
    const r = readTags("<script type='module' data-kb='bundle'></script><a href='#_top' class='x sl-skip-link'>");
    expect([r.injectedModule, r.skipLink]).toEqual([true, true]);
    const none = readTags('<script type="module"></script><a class="sl-skip-link" href="/">');
    expect([none.injectedModule, none.skipLink]).toEqual([false, false]);
    // A link with no class, and a skip link with no href, are not the skip link.
    expect(readTags('<a href="#top"><a class="sl-skip-link">').skipLink).toBe(false);
  });

  it('reads each alternate link with its type and where it points, whatever the case or the quoting, and no other link', () => {
    const html = [
      '<link rel="alternate" type="text/markdown" href="../a.md">',
      "<link REL='Canonical ALTERNATE' type=application/json href=a.json>",
      '<link rel="alternate">',
      '<link rel="stylesheet" type="text/css" href="a.css">',
      '<link href="no-rel.css">',
      '<a rel="alternate" type="text/x" href="b.html">b</a>',
    ].join('\n');
    expect(readTags(html).alternates).toEqual([
      { type: 'text/markdown', href: '../a.md' },
      { type: 'application/json', href: 'a.json' },
      { type: '', href: '' },
    ]);
  });

  it('numbers lines from offsets', () => {
    const at = lineIndex('a\nbc\n\nd');
    expect([at(0), at(1), at(2), at(4), at(5), at(6)]).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it('parses the payload only when it is the one assignment, with a pages list', () => {
    expect(parsePayload('window.kb = {"pages":[],"terms":[]};\n')).toEqual({ pages: [] });
    expect(parsePayload('window.kb = {"terms":[]};')).toBeNull();
    expect(parsePayload('window.kb = {nope};')).toBeNull();
    expect(parsePayload('var x = 1;')).toBeNull();
  });

  it('builds a fixture page with the facts the gates read', () => {
    expect(builtPage({ route: '/a/b.html', title: 'B', area: 'x', body: '' })).toContain('<script src="../kb.js"');
  });
});
