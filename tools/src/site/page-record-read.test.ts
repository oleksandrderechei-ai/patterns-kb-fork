/**
 * The page record reader: the layer rule applied to what a page states of its
 * record, and the words of each element read as the markdown's `plainText`
 * reads them. The pages are small strings in the shapes the build leaves, then
 * every page of the parity fixture, whose HTML the repo's own plugins render.
 */

import { describe, expect, it } from 'vitest';

import { expectedElements } from '../gates/check-site-parity.js';

import { paritySite } from './parity-fixtures.js';
import { readPageRecord, type PageRecordRead, type ReadElement } from './page-record-read.js';

const NBSP = String.fromCodePoint(0xa0);

const FACTS = 'data-page="/a.html" data-area="x" data-tags="t1,t2" data-kind="pattern" data-band="b" data-group="g"';

/** A page whose knowledge region holds `inner`. */
const region = (inner: string): string =>
  `<!doctype html><html><head><title>t</title></head><body><main><div class="sl-markdown-content" data-kb-region>${inner}</div></main></body></html>`;

/** A page whose region holds one article block with the six facts and `inner` inside. */
const articlePage = (inner: string, facts = FACTS): string => region(`<article ${facts}>${inner}</article>`);

/** Read a page that has a knowledge region. */
function read(html: string): PageRecordRead {
  const r = readPageRecord(html);
  expect(r).not.toBeNull();
  return r as PageRecordRead;
}

/** The elements of an article's inside, by id. */
function elements(inner: string): Map<string, ReadElement> {
  return new Map(read(articlePage(inner)).elements.map((e) => [e.id, e]));
}

/** The words of the one element with this id. */
function words(inner: string, id: string): string {
  return (elements(inner).get(id) as ReadElement).text;
}

describe('the knowledge region', () => {
  it('reads as null when no element carries the hook', () => {
    expect(readPageRecord('<!doctype html><html><body><article data-page="/a.html"><p id="x">x</p></article></body></html>')).toBeNull();
  });

  it('is the first element carrying the hook, wherever it sits', () => {
    const r = read('<html><body><div><section><div data-kb-region><article><p id="x">One</p></article></div></section></div></body></html>');
    expect([...r.elements.map((e) => e.id)]).toEqual(['x']);
  });
});

describe('the article facts', () => {
  it('reads the six facts from the class-free article block', () => {
    expect(read(articlePage('')).facts).toEqual({ page: '/a.html', area: 'x', tags: 't1,t2', kind: 'pattern', band: 'b', group: 'g' });
  });

  it('reads null for a fact the page does not state, and an empty string for one it states empty', () => {
    const facts = read(articlePage('', 'data-page="/a.html" data-tags=""')).facts;
    expect(facts).toEqual({ page: '/a.html', area: null, tags: '', kind: null, band: null, group: null });
  });

  it('reads nothing from a classed article: a class is paint, and a fact on it states nothing', () => {
    const r = read(region(`<article class="x" ${FACTS}><p id="x">x</p></article>`));
    expect(r.facts).toEqual({ page: null, area: null, tags: null, kind: null, band: null, group: null });
  });

  it('reads no facts, and no intro, from a region with no article', () => {
    const r = read(region('<p id="x">x</p>'));
    expect(r.facts.page).toBeNull();
    expect(r.intro).toEqual([]);
    expect(r.elements.map((e) => e.id)).toEqual(['x']);
  });

  it('leaves out an article marked to skip, with everything inside it', () => {
    const r = read(region(`<article data-kb-skip ${FACTS}><p id="x">x</p></article>`));
    expect(r.facts.page).toBeNull();
    expect(r.elements).toEqual([]);
  });
});

describe('blocks and groups', () => {
  const body =
    '<p id="above">Above.</p>' +
    '<section data-block="tradeoffs"><h2 id="tradeoffs">Trade-offs</h2>' +
    '<section data-polarity="pro"><h3 id="pros">Pros</h3><ul><li id="tradeoffs-pro-1">Fast</li></ul></section>' +
    '<section data-polarity="con"><ul><li id="tradeoffs-con-1">Slow</li></ul></section>' +
    '<p id="tradeoffs-p-1">After both.</p></section>' +
    '<section data-block="requirements"><section data-requirement="fr"><ul><li id="req-fr-1">Must</li></ul></section></section>' +
    '<section data-block="plain"><section><p id="plain-p-1">Inside.</p></section></section>';

  it('lists the blocks in page order', () => {
    expect(read(articlePage(body)).blocks).toEqual(['tradeoffs', 'requirements', 'plain']);
  });

  it('gives each element the block and the group section it sits in', () => {
    const at = elements(body);
    const place = (id: string): [string | null, string | null] => [(at.get(id) as ReadElement).block, (at.get(id) as ReadElement).group];
    expect(place('above')).toEqual([null, null]);
    expect(place('tradeoffs')).toEqual(['tradeoffs', null]);
    expect(place('pros')).toEqual(['tradeoffs', 'pro']);
    expect(place('tradeoffs-pro-1')).toEqual(['tradeoffs', 'pro']);
    expect(place('tradeoffs-con-1')).toEqual(['tradeoffs', 'con']);
    expect(place('tradeoffs-p-1')).toEqual(['tradeoffs', null]);
    expect(place('req-fr-1')).toEqual(['requirements', 'fr']);
  });

  it('keeps the group of the section a plain section sits in, and drops it with the block', () => {
    const at = elements(`${body}<section data-block="last"><p id="last-p-1">Last.</p></section>`);
    expect((at.get('plain-p-1') as ReadElement).group).toBeNull();
    expect((at.get('last-p-1') as ReadElement).group).toBeNull();
    const nested = elements('<section data-block="b"><section data-polarity="pro"><section><p id="deep">Deep.</p></section></section></section>');
    expect((nested.get('deep') as ReadElement).group).toBe('pro');
  });

  it('lets a section that states a block and a group at once hold both', () => {
    const at = elements('<section data-block="b" data-polarity="pro"><p id="both">Both.</p></section>');
    expect([(at.get('both') as ReadElement).block, (at.get('both') as ReadElement).group]).toEqual(['b', 'pro']);
  });

  it('reads no block or group from a classed section', () => {
    const r = read(articlePage('<section class="x" data-block="b" data-polarity="pro"><p id="in">In.</p></section>'));
    expect(r.blocks).toEqual([]);
    expect(r.elements).toEqual([{ id: 'in', tag: 'p', block: null, group: null, text: 'In.' }]);
  });

  it('reads no block from an element that is no section', () => {
    expect(read(articlePage('<div data-block="b"><p id="in">In.</p></div>')).blocks).toEqual([]);
  });
});

describe('the intro', () => {
  it('is the words of each paragraph above the first block', () => {
    const inner = '<div data-requires="a"><aside class="kb-prereq"><p>Card words.</p></aside></div><p>One   <strong>bold</strong>\n  line.</p><p>Two.</p><section data-block="d"><p>Inside.</p></section><p>After.</p>';
    expect(read(articlePage(inner)).intro).toEqual(['One bold line.', 'Two.']);
  });

  it('leaves out a paragraph marked to skip, and every element that is no paragraph', () => {
    expect(read(articlePage('<p data-kb-skip>Skipped.</p><ul><li>x</li></ul><p>Kept.</p>')).intro).toEqual(['Kept.']);
  });

  it('is every paragraph of an article that has no block at all', () => {
    expect(read(articlePage('<p>A.</p><p>B.</p>')).intro).toEqual(['A.', 'B.']);
  });

  it('stops at a block section but not at a classed section that states a block', () => {
    expect(read(articlePage('<p>A.</p><section class="x" data-block="d"></section><p>B.</p>')).intro).toEqual(['A.', 'B.']);
  });
});

describe('the words of an element', () => {
  it('collapses runs of ASCII whitespace to one space and trims, as plainText does', () => {
    expect(words('<p id="p">  A \t\n  b\r\n\fc  </p>', 'p')).toBe('A b c');
  });

  it('keeps a no-break space as a word character, written as an entity or as the character itself', () => {
    expect(words(`<p id="p">500&nbsp;ms and 5${NBSP}s</p>`, 'p')).toBe(`500${NBSP}ms and 5${NBSP}s`);
    expect(words(`<p id="p">${NBSP} edge ${NBSP}</p>`, 'p')).toBe(`${NBSP} edge ${NBSP}`);
  });

  it('shows the words of the inline elements inside, code and links among them', () => {
    expect(words('<p id="p">Use <code>x &amp; y</code> or <a href="./a.html">a <em>link</em></a>, <strong>now</strong>.</p>', 'p')).toBe('Use x & y or a link, now.');
  });

  it('shows no space for a line break of its own, and the text around a hard break shows one', () => {
    expect(words('<p id="p">a<br>b</p>', 'p')).toBe('ab');
    expect(words('<p id="p">a<br>\nb</p>', 'p')).toBe('a b');
  });

  it('shows nothing of a vector graphic, a script, a style, a comment or a subtree marked to skip', () => {
    const inner = '<p id="p">a<svg><text>HIDDEN</text></svg>b<script>var HIDDEN;</script>c<style>.HIDDEN{}</style>d<!-- HIDDEN -->e<span data-kb-skip>HIDDEN</span>f</p>';
    expect(words(inner, 'p')).toBe('abcdef');
  });

  it('reads a heading as its own words, the anchor link Starlight puts beside it being outside it', () => {
    const inner =
      '<div class="sl-heading-wrapper level-h2"><h2 id="d">What it is</h2><a class="sl-anchor-link" href="#d"><span class="sr-only">Section titled “What it is”</span></a></div>';
    expect(words(inner, 'd')).toBe('What it is');
  });

  it('reads a list, an ordered list and a table as having none', () => {
    const at = elements('<ul id="u"><li>x</li></ul><ol id="o"><li>y</li></ol><table id="t"><tbody><tr><td>z</td></tr></tbody></table>');
    expect([...at.values()].map((e) => [e.tag, e.text])).toEqual([
      ['ul', ''],
      ['ol', ''],
      ['table', ''],
    ]);
  });

  it('reads a table row as its cells joined by a bar, each as its own words', () => {
    const inner = '<table><tbody><tr id="r"><th scope="row">Edge  </th><td>one <code>x</code></td><td></td></tr></tbody></table>';
    expect(words(inner, 'r')).toBe('Edge | one x | ');
  });
});

describe('the words of a list item', () => {
  it('are its first paragraph when it opens with one', () => {
    expect(words('<ul><li id="i"><p>First   paragraph.</p><p>Second.</p></li></ul>', 'i')).toBe('First paragraph.');
  });

  it('are the inline words before the first block when it does not', () => {
    expect(words('<ul><li id="i"><strong>Lead.</strong> Then more <a href="x">words</a>.<ul><li>Nested</li></ul></li></ul>', 'i')).toBe('Lead. Then more words.');
  });

  it('are the words after a leading checkbox, which shows none', () => {
    expect(words('<ul class="contains-task-list"><li class="task-list-item" id="i"><input type="checkbox" disabled> Every field has a bound</li></ul>', 'i')).toBe(
      'Every field has a bound',
    );
  });

  it('are none when the item opens with a block of another kind, and none when it is empty', () => {
    expect(words('<ul><li id="i"><ul><li>Nested first</li></ul>Later words</li></ul>', 'i')).toBe('');
    expect(words('<ul><li id="i"></li></ul>', 'i')).toBe('');
    expect(words('<ul><li id="i">\n  <div id="fence">code</div></li></ul>', 'i')).toBe('');
  });

  it('begin after leading whitespace, as the item begins with the first thing it shows', () => {
    expect(words('<ul><li id="i">\n   <p>Spaced.</p></li></ul>', 'i')).toBe('Spaced.');
    expect(words('<ul><li id="i">  \n  Plain words.</li></ul>', 'i')).toBe('Plain words.');
  });
});

describe('the words of a sketch, a quote and a figure', () => {
  it('are the summary of a details element, and none when it has no summary of its own', () => {
    const inner =
      '<details id="s"><summary>TypeScript — the <code>smallest</code> one</summary><div class="expressive-code"></div></details>' +
      '<details id="q"><p>A plain quote.</p></details>' +
      '<details id="n"><details id="inner"><summary>Nested summary</summary></details></details>';
    const at = elements(inner);
    expect((at.get('s') as ReadElement).text).toBe('TypeScript — the smallest one');
    expect((at.get('q') as ReadElement).text).toBe('');
    expect((at.get('n') as ReadElement).text).toBe('');
    expect((at.get('inner') as ReadElement).text).toBe('Nested summary');
  });

  it('are the class-free caption of a diagram wrapper, found inside the classed figure and past the vector graphic', () => {
    const inner =
      '<div id="fig"><figure class="kb-diagram kb-wide"><div class="kb-diagram-toolbar"><svg><path d="M0"></path></svg></div>' +
      '<div class="kb-diagram-canvas"><svg><text>HIDDEN</text></svg></div><figcaption>How does it <code>work</code>?</figcaption></figure></div>';
    expect(words(inner, 'fig')).toBe('How does it work?');
  });

  it('are the caption of a captioned fence, not the header of the code frame inside it', () => {
    const inner =
      '<figure id="cap"><div class="expressive-code"><figure class="frame"><figcaption class="header">frame title</figcaption><pre><code>x</code></pre></figure></div><figcaption>What does <code>edge</code> hand over?</figcaption></figure>';
    expect(words(inner, 'cap')).toBe('What does edge hand over?');
  });

  it('are none for a wrapper with no caption, and for one whose only caption is classed or marked to skip', () => {
    const at = elements(
      '<div id="a"><pre><code>x</code></pre></div>' +
        '<div id="b"><figcaption class="header">framed</figcaption></div>' +
        '<div id="c"><div data-kb-skip><figcaption>skipped</figcaption></div></div>',
    );
    expect([...at.values()].map((e) => e.text)).toEqual(['', '', '']);
  });
});

describe('ids', () => {
  it('lists every element carrying an id in page order, with its tag', () => {
    const at = read(articlePage('<p id="a">A</p><section data-block="b"><h2 id="b">B</h2><ul><li id="b-1">One</li></ul></section>'));
    expect(at.elements.map((e) => [e.id, e.tag])).toEqual([
      ['a', 'p'],
      ['b', 'h2'],
      ['b-1', 'li'],
    ]);
  });

  it('reads an id from a classed element as well: an id is an anchor, never a fact', () => {
    expect(read(articlePage('<div class="kb-wide" id="wrap"><p id="in">x</p></div>')).elements.map((e) => e.id)).toEqual(['wrap', 'in']);
  });

  it('does not enter code, a vector graphic or a subtree marked to skip, and does read the element that holds them', () => {
    const inner =
      '<div id="holder"><pre id="frame"><span id="in-pre">x</span></pre><svg><g id="in-svg"></g></svg><div data-kb-skip id="skipped"><p id="in-skip">x</p></div></div>' +
      '<script id="in-script">var x;</script>';
    expect(read(articlePage(inner)).elements.map((e) => e.id)).toEqual(['holder', 'frame', 'in-script']);
  });
});

describe('relations', () => {
  /** A relationships block holding `items`. */
  const relationships = (items: string): string => `<section data-block="relationships"><ul>${items}</ul></section>`;

  it('reads the verb and the target of each list item of the relationships block that states them, in page order', () => {
    const inner = relationships('<li data-verb="combines-with" data-to="retry">Retry</li><li data-verb="prevents-hazard" data-to="storm">Storm</li>');
    expect(read(articlePage(inner)).relations).toEqual([
      { verb: 'combines-with', to: 'retry' },
      { verb: 'prevents-hazard', to: 'storm' },
    ]);
  });

  it('reads an empty string for the fact an item does not state, and skips an item that states neither', () => {
    const inner = relationships('<li data-verb="a">Verb only</li><li data-to="b">Target only</li><li>Neither</li>');
    expect(read(articlePage(inner)).relations).toEqual([
      { verb: 'a', to: '' },
      { verb: '', to: 'b' },
    ]);
  });

  it('reads nothing from a classed item', () => {
    expect(read(articlePage(relationships('<li class="x" data-verb="a" data-to="b">x</li>'))).relations).toEqual([]);
  });

  it('reads nothing from an item of another block, or of none', () => {
    const items = '<ul><li data-verb="a" data-to="b">x</li></ul>';
    expect(read(articlePage(`${items}<section data-block="fluency">${items}</section>`)).relations).toEqual([]);
  });

  it('reads nothing from inside a vector graphic, where a diagram element may carry a data-to of its own', () => {
    const graphic =
      '<div id="fig"><figure class="kb-diagram"><svg><g><line data-to="x" data-verb="y"></line><foreignObject><div><ul><li data-verb="a" data-to="b">x</li></ul></div></foreignObject></g></svg></figure></div>';
    const inner = `<section data-block="relationships">${graphic}<ul><li data-verb="real" data-to="one">Real</li></ul></section>`;
    expect(read(articlePage(inner)).relations).toEqual([{ verb: 'real', to: 'one' }]);
  });
});

describe('the prerequisite card', () => {
  it('reads the two lists of ids from the class-free wrapper', () => {
    const inner = '<div data-requires="timeout,deadline" data-related="a,b,c"><aside class="kb-prereq"></aside></div>';
    expect(read(articlePage(inner)).prerequisites).toEqual({ requires: ['timeout', 'deadline'], related: ['a', 'b', 'c'] });
  });

  it('reads an empty list for the fact the card does not state, or states empty', () => {
    expect(read(articlePage('<div data-requires="a" data-related=""></div>')).prerequisites).toEqual({ requires: ['a'], related: [] });
    expect(read(articlePage('<div data-related="b"></div>')).prerequisites).toEqual({ requires: [], related: ['b'] });
  });

  it('is two empty lists when the page has no card, or its wrapper is classed', () => {
    expect(read(articlePage('<p>x</p>')).prerequisites).toEqual({ requires: [], related: [] });
    expect(read(articlePage('<div class="x" data-requires="a" data-related="b"></div>')).prerequisites).toEqual({ requires: [], related: [] });
  });
});

describe('a rendered page', () => {
  it('has the ids its record lists, in the order it lists them, whatever else the page carries', () => {
    for (const record of paritySite().records) {
      const html = paritySite().dist.get(record.route.slice(1)) as string;
      const page = read(html);
      const ids = new Set(Object.keys(record.anchors));
      expect(page.elements.filter((e) => ids.has(e.id)).map((e) => e.id), record.id).toEqual(Object.keys(record.anchors));
      expect(page.blocks, record.id).toEqual(record.blocks.map((b) => b.name));
    }
  });

  it('shows every element the words and the place its record gives it', () => {
    for (const record of paritySite().records) {
      const page = read(paritySite().dist.get(record.route.slice(1)) as string);
      const byId = new Map(page.elements.map((e) => [e.id, e]));
      for (const want of expectedElements(record)) expect(byId.get(want.id), `${record.id}#${want.id}`).toEqual(want);
    }
  });
});
