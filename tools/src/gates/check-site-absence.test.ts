/**
 * The data-layer half of the absence gate (spec kb.pagedata.two-layers), and
 * two-layers-O1: each of two faults, over one page alone, is one finding naming
 * the page and the element or attribute, and removing it clears the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectFail, expectMisuse, expectPass, makeSandbox, type Sandbox } from '../lib/sandbox.js';
import { formatHtml } from '../site/site-format.js';
import { BUILT, builtPage, formattedSite, upstreamFiles, withUpstream } from '../site/site-fixtures.js';
import { LISTS, NOISE, NOSCRIPT_STYLE, type NoiseLists } from '../lib/site-noise.js';
import * as format from '../site/site-format.js';
import { absence, fixedPoint, isFact, isVendor, pageFindings, spec, SUMMARY, VENDOR } from './check-site-absence.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

/** The finding lines of a run's stderr: a note is not one. */
const findings = (err: string): string[] => err.split('\n').filter((l) => /\] FAIL[ :]/.test(l));

/** A clean built page whose article holds `body`. */
const page = (body: string): string => builtPage({ route: '/patterns/caching/alpha.html', title: 'Alpha', area: 'caching', body });

describe('absence-gate-O1', () => {
  it('absence-gate-O1: two formatted pages with one classic kb.js and one article block each pass with a count of 2; a module bundle tag fails, naming the page and the bundle', async () => {
    const home = builtPage({ route: '/index.html', title: 'KB', area: 'patterns', body: '<p>Start.</p>' });
    const alpha = builtPage({ route: '/patterns/caching/alpha.html', title: 'Alpha', area: 'caching', body: '<p>Alpha.</p>' });
    // Each page also carries what the real build adds, so every allowlist entry is met.
    sb.write('site/dist/index.html', formatHtml(withUpstream(home, '/index.html')));
    sb.write('site/dist/patterns/caching/alpha.html', formatHtml(withUpstream(alpha, '/patterns/caching/alpha.html')));
    sb.write('site/dist/kb.js', '/* the bundle */\n');
    upstreamFiles(sb);

    const clean = await sb.run(spec);
    expectPass(clean);
    expect(clean.out.split('\n')).toHaveLength(1);
    expect(clean.out).toMatch(/^\[site-absence\] 2 pages: /);

    const moduled = sb.read('site/dist/patterns/caching/alpha.html').replace('<script src="../../kb.js"', '<script type="module" src="../../kb.js"');
    sb.write('site/dist/patterns/caching/alpha.html', moduled);
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      '[site-absence] FAIL site/dist/patterns/caching/alpha.html: the kb.js bundle loads as a module — a module never runs from a folder; it loads as a classic script',
    ]);
  });
});

describe('the noise half, end to end', () => {
  /** The gate with lists of its own, the way a measured site runs it. */
  const measured = (lists: NoiseLists): typeof spec => ({ ...spec, run: (ctx) => absence(ctx, 'site/dist', lists) });

  it('fails a page off the fixed point, naming the formatter as the repair, and a script file nothing loads', async () => {
    formattedSite(sb);
    sb.write('site/dist/hazards/gamma.html', builtPage(BUILT.find((p) => p.title === 'Gamma') as (typeof BUILT)[number]));
    sb.write('site/dist/_astro/stray.js', 'export {}\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      "[site-absence] FAIL site/dist/hazards/gamma.html: not at the formatter’s fixed point — run make site-build (or tsx tools/src/site/site-format.ts)",
      '[site-absence] FAIL site/dist/_astro/stray.js: a script file no page loads and no loaded script imports — the post-build pass prunes these; stop shipping it',
    ]);
  });

  /** Plant `html` before </body> of one formatted page and reformat it, so only the plant differs. */
  const plant = (html: string, route = 'site/dist/patterns/caching/beta.html'): void => {
    sb.write(route, formatHtml(sb.read(route).replace('</body>', `${html}</body>`)));
  };
  const BETA = 'site/dist/patterns/caching/beta.html';

  it('fails each thing the lists do not name, with the add-or-stop repair, and passes once it is removed (absence-gate-C3)', async () => {
    const plants: [string, string][] = [
      ['<script src="https://cdn.example.com/x.js"></script>', NOISE.namedScripts.external('https://cdn.example.com/x.js')],
      ['<script>document.title = "x"</script>', NOISE.namedScripts.inline('document.title = "x"')],
      ['<link rel="stylesheet" href="../../_astro/style.fixture.css">', NOISE.mainStylesheet.count(2)],
      ['<link rel="stylesheet" href="../../_astro/extra.css">', NOISE.mainStylesheet.unnamed('../../_astro/extra.css')],
    ];
    for (const [html, what] of plants) {
      formattedSite(sb);
      plant(html);
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toEqual([`[site-absence] FAIL ${BETA}: ${what}`]);
      formattedSite(sb);
      expectPass(await sb.run(spec));
    }
  });

  it('fails a changed noscript selector until its entry changes too, and a missing noscript style', async () => {
    formattedSite(sb);
    const changed = NOSCRIPT_STYLE.replace('.kb-favourite', '.kb-favourite-x');
    sb.write(BETA, sb.read(BETA).replace(NOSCRIPT_STYLE, changed));
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `[site-absence] FAIL ${BETA}: ${NOISE.noscriptStyle.unnamed(changed.slice(0, 60))}`,
      `[site-absence] FAIL ${BETA}: ${NOISE.noscriptStyle.missing((LISTS.noscriptStyles[0] as { match: RegExp }).match.source)}`,
    ]);
    // Change the line on every page and its entry too: the run passes.
    const both: NoiseLists = {
      ...LISTS,
      noscriptStyles: [{ id: 'no-script-controls', reason: 'the changed line, audited', match: new RegExp(`^${changed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }],
    };
    for (const p of BUILT) sb.write(`site/dist${p.route}`, sb.read(`site/dist${p.route}`).replace(NOSCRIPT_STYLE, changed));
    expectPass(await sb.run(measured(both)));

    formattedSite(sb);
    sb.write(BETA, formatHtml(sb.read(BETA).replace(/<noscript>[\s\S]*?<\/noscript>/, '')));
    const gone = await sb.run(spec);
    expectFail(gone);
    expect(findings(gone.err)).toEqual([`[site-absence] FAIL ${BETA}: ${NOISE.noscriptStyle.missing((LISTS.noscriptStyles[0] as { match: RegExp }).match.source)}`]);
  });

  it('fails an inline module and a module bundle whatever the spelling of its type, and a handler inside a vector graphic', async () => {
    const plants: [string, string][] = [
      ['<script type="Module">console.log(1)</script>', NOISE.inlineModule.fail('console.log(1)')],
      ['<script type=" module ">console.log(1)</script>', NOISE.inlineModule.fail('console.log(1)')],
      ['<svg aria-hidden="true" onclick="x()"><g></g></svg>', NOISE.handlers.fail('onclick')],
    ];
    for (const [html, what] of plants) {
      formattedSite(sb);
      plant(html);
      const r = await sb.run(spec);
      expectFail(r);
      expect(findings(r.err)).toEqual([`[site-absence] FAIL ${BETA}: ${what}`]);
    }
    formattedSite(sb);
    sb.write(BETA, sb.read(BETA).replace('<script src="../../kb.js"', '<script type="Module" src="../../kb.js"'));
    expect(findings((await sb.run(spec)).err)).toEqual([`[site-absence] FAIL ${BETA}: ${NOISE.bundle.module}`]);
    formattedSite(sb);
    plant('<script type="module" src="../../kb.js?v=2"></script>');
    expect(findings((await sb.run(spec)).err)).toEqual([`[site-absence] FAIL ${BETA}: ${NOISE.bundle.module}`, `[site-absence] FAIL ${BETA}: ${NOISE.bundle.count(2)}`]);
  });

  it('holds 404.html to its own rule: a standalone page with one style passes, and the same file as any other page would fail', async () => {
    formattedSite(sb);
    const notFound = [
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Page not found</title>',
      '<script type="application/ld+json" data-kb="page">{"@context":"https://schema.org","@type":"TechArticle","headline":"Page not found"}</script>',
      '<style>body { margin: 0; background: Canvas; }</style></head><body><main>',
      '<div data-page-head><h1>Page not found</h1></div>',
      '<div class="kb-not-found" data-kb-region><article data-page="/404.html" data-area="patterns" data-tags="a"><p>Gone.</p></article></div>',
      '</main></body></html>',
    ].join('');
    sb.write('site/dist/404.html', formatHtml(notFound));
    expectPass(await sb.run(spec));

    // Another page with the same markup has no bundle and no stylesheet, and carries a style element.
    sb.write('site/dist/hazards/gamma.html', formatHtml(notFound.replace('/404.html', '/hazards/gamma.html')));
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err).filter((l) => l.includes('hazards/gamma.html')).map((l) => l.replace(/^.*gamma\.html: /, ''))).toEqual(
      expect.arrayContaining([NOISE.styleElement.fail, NOISE.bundle.count(0), NOISE.mainStylesheet.count(0)]),
    );
    expect(findings(r.err).some((l) => l.includes('404.html'))).toBe(false);

    // The exception does not let 404.html load a file.
    sb.write('site/dist/hazards/gamma.html', sb.read('site/dist/hazards/gamma.html'));
    sb.write('site/dist/404.html', formatHtml(notFound.replace('<style>', '<link rel="stylesheet" href="_astro/style.abc.css"><style>')));
    const loaded = await sb.run(spec);
    expect(findings(loaded.err).filter((l) => l.includes('404.html'))).toEqual([
      `[site-absence] FAIL site/dist/404.html: ${NOISE.notFound.load('<link rel="stylesheet" href="_astro/style.abc.css">')}`,
    ]);
  });

  it('fails a stray .mjs or .cjs file as it does a stray .js', async () => {
    formattedSite(sb);
    sb.write('site/dist/_astro/stray.mjs', 'export {}\n');
    sb.write('site/dist/_astro/stray.cjs', 'module.exports = {}\n');
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `[site-absence] FAIL site/dist/_astro/stray.cjs: ${NOISE.unreachable.fail}`,
      `[site-absence] FAIL site/dist/_astro/stray.mjs: ${NOISE.unreachable.fail}`,
    ]);
  });

  it('owes a conditional entry only on a site with the file that entry needs, and then fails when no page carries it', async () => {
    formattedSite(sb);
    const only = (needs: RegExp): NoiseLists => ({
      ...LISTS,
      externalScripts: [...LISTS.externalScripts, { id: 'sometimes', reason: 'a chunk only some builds emit', match: /^sometimes\.js$/, needs }],
    });
    expectPass(await sb.run(measured(only(/^map\/stack\.html$/))));

    const r = await sb.run(measured(only(/^patterns\/caching\/beta\.html$/)));
    expectFail(r);
    expect(findings(r.err)).toEqual([`[site-absence] FAIL: ${NOISE.unusedEntry.fail('sometimes')}`]);
  });

  it('names every property in the summary line', async () => {
    formattedSite(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.err).toBe('');
    expect(r.out).toBe(`[site-absence] ${BUILT.length} pages: ${SUMMARY}`);
    for (const p of Object.values(NOISE)) if ('holds' in p) expect(SUMMARY).toContain(p.holds);
  });

  it('an entry that matched nothing is a finding, and the lists that match every page pass quietly', async () => {
    formattedSite(sb);
    const quiet = await sb.run(measured(LISTS));
    expectPass(quiet);
    expect(quiet.err).toBe('');

    const extra = { ...LISTS, externalScripts: [...LISTS.externalScripts, { id: 'gone', reason: 'a chunk the build stopped emitting', match: /^gone\.js$/ }] };
    const r = await sb.run(measured(extra));
    expectFail(r);
    expect(findings(r.err)).toEqual(["[site-absence] FAIL: the allowlist entry 'gone' in tools/src/lib/site-noise.ts matched nothing on any page — drop it"]);
  });

  it('names the formatter as the repair for a page off its fixed point', () => {
    expect(fixedPoint('<p>\n  x\n</p>\n')).toBeNull();
    expect(fixedPoint('<p>x</p>')).toMatch(/fixed point/);
  });

  it('carries the formatter’s refusal as the finding’s reason', () => {
    const refusal = new Error('site-format refuses: the painted text would change');
    const spy = vi.spyOn(format, 'formatHtml').mockImplementation(() => {
      throw refusal;
    });
    try {
      expect(fixedPoint('<p>x</p>')).toBe(refusal.message);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('two-layers-O1', () => {
  it('two-layers-O1: a classed element with a fact, then a data block with a foreign attribute — each page alone fails once, and passes once fixed', async () => {
    // Each page is the only page of its own built site, so the gate reads it alone.
    const alone = (dist: string, body: string): string => {
      const file = `${dist}/patterns/caching/alpha.html`;
      sb.write(file, formatHtml(withUpstream(page(body), '/patterns/caching/alpha.html', { code: true })));
      upstreamFiles(sb, dist);
      return file;
    };
    const classed = '<div class="note" data-topic="x">Note.</div>';
    const foreign = '<section data-topic="x" role="note">Note.</section>';
    const a = alone('one', classed);
    const b = alone('two', foreign);

    const first = await sb.run(spec, ['--dist', 'one']);
    expectFail(first);
    expect(findings(first.err)).toEqual([
      `[site-absence] FAIL ${a}: fact data-topic on the classed element <div class="note"> — a fact sits on a class-free element`,
    ]);
    const second = await sb.run(spec, ['--dist', 'two']);
    expectFail(second);
    expect(findings(second.err)).toEqual([`[site-absence] FAIL ${b}: data block <section> carries role — a data block holds only data-* and an id`]);

    alone('one', '<div data-topic="x">Note.</div>');
    alone('two', '<section data-topic="x">Note.</section>');
    expectPass(await sb.run(spec, ['--dist', 'one']));
    expectPass(await sb.run(spec, ['--dist', 'two']));
  });
});

describe('pageFindings', () => {
  it('passes facts on class-free blocks — one with an id, a title block around a classed H1', () => {
    const html = page('<p id="p-1" data-note="deeper">x</p>').replace('<h1 id="_top">', '<h1 class="title" id="_top">');
    expect(pageFindings(html, false)).toEqual([]);
  });

  it('shields nothing in a skip-marked subtree, and reads no text as markup', () => {
    const html = page(
      '<p>Writing data-kb-skip or &lt;div class="x" data-topic="y"&gt; is text.</p><span title="data-kb-skip">t</span>',
    ).replace('</main>', '</main><footer data-kb-skip><div class="f" data-topic="x">f</div></footer>');
    expect(pageFindings(html, false)).toEqual([]);
  });

  it('lets a vendor attribute sit on a class-free element beside a title', () => {
    expect(pageFindings(page('<button title="Copy" data-copied="Copied!" data-code="x">c</button>'), false)).toEqual([]);
  });

  it('ignores what vector graphics, scripts and code carry', () => {
    const body =
      '<svg class="s" data-topic="x"><g class="g" data-id="n"></g></svg><pre class="p"><code><span class="c" data-topic="x">x</span></code></pre>' +
      '<script>document.body.dataset.topic = "x";</script>';
    expect(pageFindings(page(body), false)).toEqual([]);
  });

  it('reads a code or script element’s own attributes: a class and a fact on a <pre> or <code> is a finding', () => {
    const body =
      '<pre class="plant" data-topic="y"><code>x</code></pre><code class="plant" data-topic="z">A9</code>' +
      '<pre data-topic="w" tabindex="0"><code>y</code></pre>';
    expect(pageFindings(page(body), false)).toEqual([
      'fact data-topic on the classed element <pre class="plant"> — a fact sits on a class-free element',
      'fact data-topic on the classed element <code class="plant"> — a fact sits on a class-free element',
      'data block <pre> carries tabindex — a data block holds only data-* and an id',
    ]);
  });

  it('takes the language Expressive Code writes on its <pre> as the vendor’s, not a fact', () => {
    expect(isVendor('data-language')).toBe(true);
    expect(pageFindings(page('<pre data-language="json" tabindex="0"><code>{}</code></pre>'), false)).toEqual([]);
  });

  it('fails a skip marker inside the knowledge region, naming the element', () => {
    expect(pageFindings(page('<p data-kb-skip>x</p><nav class="toc" data-kb-skip>y</nav>'), false)).toEqual([
      'a skip marker on <p> inside the knowledge region — nothing there may be dropped',
      'a skip marker on <nav class="toc"> inside the knowledge region — nothing there may be dropped',
    ]);
  });

  it('fails a region that is not one article carrying exactly the three page facts, or those and the place', () => {
    const extra = page('<p>x</p>').replace('data-tags="caching,performance">', 'data-tags="caching,performance" data-owner="x">');
    expect(pageFindings(extra, false)).toContain(
      'the knowledge region is not one <article> carrying exactly data-page, data-area, data-tags, then all of data-kind, data-band, data-group or none of them — run the post-build pass',
    );
    const two = page('<p>x</p>').replace('</article>', '</article><p>stray</p>');
    expect(pageFindings(two, false)).toHaveLength(1);
    const none = page('<p>x</p>').replace(/<article[^>]*>/, '<div>').replace('</article>', '</div>');
    expect(pageFindings(none, false)).toHaveLength(1);
    const empty = page('').replace(/<article[^>]*><\/article>/, '');
    expect(pageFindings(empty, false)).toHaveLength(1);
  });

  describe('the place of a page of the knowledge base', () => {
    const TAGS = 'data-tags="caching,performance"';
    const PLACE = 'data-kind="pattern" data-band="caching" data-group="caching"';
    const WANT =
      'the knowledge region is not one <article> carrying exactly data-page, data-area, data-tags, then all of data-kind, data-band, data-group or none of them — run the post-build pass';
    /** The page with its article's facts after `data-area` written as `facts`. */
    const withFacts = (facts: string): string => page('<p>x</p>').replace(TAGS, facts);

    it('accepts the three page facts alone, and the three followed by the kind, the band and the group', () => {
      expect(pageFindings(withFacts(TAGS), false)).toEqual([]);
      expect(pageFindings(withFacts(`${TAGS} ${PLACE}`), false)).toEqual([]);
    });

    it('fails a place that is partly there, whichever of the three is missing', () => {
      for (const part of ['data-kind="pattern"', 'data-band="caching"', 'data-group="caching"', 'data-kind="pattern" data-band="caching"', 'data-band="caching" data-group="caching"']) {
        expect(pageFindings(withFacts(`${TAGS} ${part}`), false), part).toEqual([WANT]);
      }
    });

    it('fails a place out of order, and one that comes before the page facts', () => {
      expect(pageFindings(withFacts(`${TAGS} data-band="caching" data-kind="pattern" data-group="caching"`), false)).toEqual([WANT]);
      expect(pageFindings(page('<p>x</p>').replace('<article data-page', `<article ${PLACE} data-page`), false)).toEqual([WANT]);
    });

    it('still fails a page fact among the place that no page carries', () => {
      expect(pageFindings(withFacts(`${TAGS} ${PLACE} data-owner="x"`), false)).toEqual([WANT]);
    });
  });

  describe('the verb and target of a relationship item', () => {
    /** A page whose relationships block holds the one `item`. */
    const listing = (item: string): string =>
      page(`<section data-block="relationships"><p id="p-1"><strong>Combines with</strong></p><ul>${item}</ul></section>`);

    it('are facts of a class-free item, which carries them beside nothing but data-* and an id', () => {
      expect(pageFindings(listing('<li data-verb="combines-with" data-to="retry"><a href="./retry.html">Retry</a> — note</li>'), false)).toEqual([]);
      expect(pageFindings(listing('<li id="r-1" data-verb="combines-with" data-to="retry"><a href="./retry.html">Retry</a></li>'), false)).toEqual([]);
    });

    it('fail on a classed item, naming the attribute and the element, and on an item that carries anything else', () => {
      expect(pageFindings(listing('<li class="row" data-verb="combines-with" data-to="retry">x</li>'), false)).toEqual([
        'fact data-verb on the classed element <li class="row"> — a fact sits on a class-free element',
        'fact data-to on the classed element <li class="row"> — a fact sits on a class-free element',
      ]);
      expect(pageFindings(listing('<li title="t" data-verb="combines-with" data-to="retry">x</li>'), false)).toEqual([
        'data block <li> carries title — a data block holds only data-* and an id',
      ]);
    });
  });

  it('fails a page with no knowledge region, and a page but the home page with no title block', () => {
    const bare = '<!doctype html><html><head></head><body><h1>T</h1></body></html>';
    expect(pageFindings(bare, false)).toEqual(['no knowledge region (no element carries data-kb-region)', 'no class-free data-page-head block holds the H1']);
    expect(pageFindings(bare, true)).toEqual(['no knowledge region (no element carries data-kb-region)']);
    // Found by its hook, never by the class Starlight gives it.
    const byClass = page('<p>x</p>').replace(' data-kb-region', '');
    expect(pageFindings(byClass, false)).toEqual(['no knowledge region (no element carries data-kb-region)']);
    const two = page('<p>x</p>').replace('</main>', '<div class="more" data-kb-region><article data-page="/x.html" data-area="a" data-tags=""></article></div></main>');
    expect(pageFindings(two, false)).toEqual(['2 knowledge regions (2 elements carry data-kb-region) — a page has one']);
    const classedHead = page('<p>x</p>').replace('<div data-page-head>', '<div class="head" data-page-head>');
    expect(pageFindings(classedHead, false)).toContain('no class-free data-page-head block holds the H1');
    const noTitle = page('<p>x</p>').replace(/<div data-page-head>.*?<\/div>/, '<div data-page-head>Just words.</div><h1>Loose</h1>');
    expect(pageFindings(noTitle, false)).toEqual(['no class-free data-page-head block holds the H1']);
  });
});

describe('two-layers-C5', () => {
  it('two-layers-C5: the knowledge region is a classed wrapper around the article block, and one with no class is a finding', () => {
    expect(pageFindings(page('<p>x</p>'), false)).toEqual([]);
    const bare = page('<p>x</p>').replace('<div class="sl-markdown-content" data-kb-region>', '<div data-kb-region>');
    expect(pageFindings(bare, false)).toEqual([
      'the knowledge region <div> carries no class — it is the classed wrapper around the article block, never a data block',
    ]);
  });
});

describe('the attribute kinds', () => {
  it('reads a hook and a vendor name as never a fact, and everything else bare as one', () => {
    expect(isFact('data-kb')).toBe(false);
    expect(isFact('data-kb-diagram-act')).toBe(false);
    expect(isFact('data-theme')).toBe(false);
    expect(isFact('data-note')).toBe(true);
    expect(isFact('id')).toBe(false);
    expect(isVendor('data-pagefind-body')).toBe(true);
    expect(isVendor('data-pagefind-bodyx')).toBe(false);
  });

  it('gives every vendor entry an id, a reason and an anchored pattern', () => {
    for (const v of VENDOR) {
      expect(v.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(v.reason.length).toBeGreaterThan(20);
      expect(v.match.source.startsWith('^') && v.match.source.endsWith('$')).toBe(true);
    }
  });
});

describe('check-site-absence', () => {
  it('passes a clean built site with one summary line', async () => {
    formattedSite(sb);
    const r = await sb.run(spec);
    expectPass(r);
    expect(r.out).toMatch(new RegExp(`^\\[site-absence\\] ${BUILT.length} pages: `));
  });

  it('passes a built page of the knowledge base, its article stating its place and each relationship item its relation, and fails it with the place cut short', async () => {
    formattedSite(sb);
    const alpha = 'site/dist/patterns/caching/alpha.html';
    const place = ' data-kind="pattern" data-band="caching" data-group="caching"';
    const stamped = formatHtml(
      sb
        .read(alpha)
        .replace('data-tags="caching,performance">', `data-tags="caching,performance"${place}>`)
        .replace(
          '</article>',
          '<section data-block="relationships"><ul><li data-verb="combines-with" data-to="beta"><a href="./beta.html">Beta</a> — note</li></ul></section></article>',
        ),
    );
    sb.write(alpha, stamped);
    expectPass(await sb.run(spec));

    sb.write(alpha, formatHtml(stamped.replace(' data-group="caching"', '')));
    const r = await sb.run(spec);
    expectFail(r);
    expect(findings(r.err)).toEqual([
      `[site-absence] FAIL ${alpha}: the knowledge region is not one <article> carrying exactly data-page, data-area, data-tags, then all of data-kind, data-band, data-group or none of them — run the post-build pass`,
    ]);
  });

  it('asks for a build when there is no built site, an empty one, or --dist is empty', async () => {
    expectFail(await sb.run(spec), 'no built site at site/dist');
    expectFail(await sb.run(spec, ['--dist', '']), "no built site at ''");
    sb.mkdir('site/dist');
    expectFail(await sb.run(spec), 'no .html files under site/dist');
  });

  it('exits 2 on an unknown flag, writing nothing', async () => {
    formattedSite(sb);
    const before = sb.snapshot();
    expectMisuse(await sb.run(spec, ['--nope']));
    expect(sb.snapshot()).toEqual(before);
  });
});
