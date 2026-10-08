/**
 * The not-found page made standalone: no link to a file of the site, its own
 * small style, absolute links under the published root, and the facts the
 * pipeline reads kept.
 */

import { describe, expect, it } from 'vitest';

import { NOT_FOUND_STYLE, NotFoundShapeError, standaloneNotFound } from './site-not-found.js';

const ROOT = new URL('https://odere-pro.github.io/software-design-atlas/');

/** A not-found page as Starlight builds it: its chrome, its assets, its title block and its region. */
const BUILT = `<!DOCTYPE html>
<html lang="en" dir="ltr" data-theme="dark" data-has-sidebar class="astro-x">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Page not found · Software Design Atlas</title><link rel="canonical" href="https://odere-pro.github.io/404.html"/><link rel="sitemap" href="/sitemap-index.xml"/><link rel="shortcut icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/apple-touch-icon.png"/><meta name="description" content="The address you opened is not a page of this site."/>
<meta name="kb:area" content="patterns"><meta name="kb:owner" content="Oleksandr Derechei">
<script type="application/ld+json" data-kb="page">{"@context":"https://schema.org","headline":"Page not found"}</script>
<script src="/kb.js" defer data-kb="bundle"></script>
<noscript><style>.kb-search-open { display: none; }</style></noscript>
<script>(() => { document.documentElement.dataset.theme = 'dark'; })();</script>
<link rel="stylesheet" href="/_astro/print.css" media="print"><link rel="stylesheet" href="/_astro/style.css"><script type="module" src="/_astro/page.js"></script></head>
<body class="astro-x">
<header class="header"><a href="/index.html">Software Design Atlas</a></header>
<main>
<div data-page-head>
      <h1 id="_top" class="astro-y">Page not found</h1>
    </div>
<div class="sl-markdown-content" data-kb-region><article data-page="/404.html" data-area="patterns" data-tags="a,b">
<p>That address is not a page here. <a href="/index.html">Home</a> or <a href="/index.html#search">search</a>, or <a href="https://example.org/x">elsewhere</a>.</p>
</article></div>
<footer data-kb-skip class="sl-flex"></footer>
</main>
</body>
</html>`;

describe('standaloneNotFound', () => {
  const out = standaloneNotFound(BUILT, ROOT);

  it('carries no stylesheet, script, icon or other link to a file of the site', () => {
    expect(out).not.toMatch(
      /<link\b[^>]*rel="(?:stylesheet|shortcut icon|apple-touch-icon|sitemap|modulepreload|preload)"/,
    );
    expect(out).not.toMatch(/<script\b(?![^>]*ld\+json)/);
    expect(out).not.toMatch(/\bsrc=/);
    expect(out).not.toContain('<noscript');
    expect(out).not.toMatch(/(?:href|src)="(?!https?:\/\/|#)/);
  });

  it('carries its own one style element, which names no colour and reads both schemes', () => {
    expect(out.match(/<style\b/g)).toHaveLength(1);
    expect(out).toContain(NOT_FOUND_STYLE);
    expect(NOT_FOUND_STYLE).toContain('prefers-color-scheme: dark');
    expect(NOT_FOUND_STYLE).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  });

  it('drops the chrome around the content', () => {
    expect(out).not.toContain('<header');
    expect(out).not.toContain('<footer');
    expect(out).not.toContain('Software Design Atlas</a>');
  });

  it('keeps the title, the page facts, the description and the JSON-LD block', () => {
    expect(out).toContain('<title>Page not found · Software Design Atlas</title>');
    expect(out).toContain('<meta name="kb:area" content="patterns">');
    expect(out).toContain('<meta name="kb:owner" content="Oleksandr Derechei">');
    expect(out).toContain('<meta name="description" content="The address you opened is not a page of this site."/>');
    expect(out).toContain('<meta charset="utf-8"/>');
    expect(out).toContain('<script type="application/ld+json" data-kb="page">');
    expect(out).toContain('<link rel="canonical" href="https://odere-pro.github.io/404.html"/>');
  });

  it('keeps one title block around a plain h1 and one knowledge region around the rest', () => {
    expect(out).toContain('<div data-page-head><h1 id="_top">Page not found</h1></div>');
    expect(out.match(/data-kb-region/g)).toHaveLength(1);
    expect(out).toContain('<div class="kb-not-found" data-kb-region>');
    expect(out).not.toContain('<article');
    expect(out).toContain('<p>That address is not a page here.');
  });

  it('makes each root link absolute under the published root, so it lands from any depth', () => {
    expect(out).toContain('<a href="https://odere-pro.github.io/software-design-atlas/index.html">Home</a>');
    expect(out).toContain('href="https://odere-pro.github.io/software-design-atlas/index.html#search"');
    expect(out).toContain('href="https://example.org/x"');
  });

  it('keeps the skip link every page has, aimed at the title', () => {
    expect(out).toContain('<a class="sl-skip-link" href="#_top">Skip to content</a>');
    expect(out).toContain('id="_top"');
  });

  it('puts the page in the browser’s language, with one main landmark', () => {
    expect(out).toContain('<html lang="en" dir="ltr">');
    expect(out.match(/<main>/g)).toHaveLength(1);
  });

  it('reads a root on another origin and path, as a fork’s SITE_URL gives', () => {
    const fork = standaloneNotFound(BUILT, new URL('https://docs.example.com/kb/'));
    expect(fork).toContain('href="https://docs.example.com/kb/index.html"');
  });

  it('is the same page when read a second time', () => {
    expect(standaloneNotFound(out, ROOT)).toBe(out);
  });

  it('refuses a page with no head, no title block or no region, naming which', () => {
    expect(() => standaloneNotFound('<body></body>', ROOT)).toThrow(NotFoundShapeError);
    expect(() => standaloneNotFound('<head></head><body></body>', ROOT)).toThrow('title block');
    expect(() => standaloneNotFound('<head></head><div data-page-head><h1>x</h1></div>', ROOT)).toThrow('knowledge region');
  });
});
