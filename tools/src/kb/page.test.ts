/**
 * One page's structure: frontmatter left to its door, blocks by their facts,
 * marked regions, links, clicks, and the writer-owned blocks dumped
 * in the writers' shape.
 */

import { describe, expect, it } from 'vitest';

import type { Paragraph, PhrasingContent } from '../lib/kb-attrs.js';

import {
  blockNamed,
  clickTargets,
  inline,
  inlineOf,
  explainItems,
  linksIn,
  mdPlain,
  parsePage,
  productionItems,
  proseLinks,
  rich,
  stripFrontmatter,
  wildItems,
  type Block,
} from './page.js';

const para = (md: string): Paragraph => parsePage(md).tree.children[0] as Paragraph;

describe('parsePage', () => {
  it('leaves the frontmatter out, and reads a page that has none', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\n# T\n')).toBe('# T\n');
    expect(stripFrontmatter('# T\n')).toBe('# T\n');
    expect(parsePage('---\ntitle: x\n---\n\n# Title\n\nIntro.\n').h1).toBe('Title');
  });

  it('keeps the markdown the tree was parsed from: the page less its frontmatter, which the positions index into', () => {
    const body = '# Title\n\nIntro with `code`.\n\n## First\n<!--meta block=description-->\n\nA **bold** word.\n';
    const doc = parsePage(`---\ntitle: x\n---\n${body}`);
    expect(doc.source).toBe(body);
    expect(parsePage(body).source).toBe(body);
    const intro = doc.intro[0] as Paragraph;
    const at = intro.position as { start: { offset: number }; end: { offset: number } };
    expect(doc.source.slice(at.start.offset, at.end.offset)).toBe('Intro with `code`.');
  });

  it('splits the blocks by their facts; what sits under a heading with none belongs to no block', () => {
    const doc = parsePage(
      [
        '# Title',
        '',
        'Intro one.',
        '',
        '## First',
        '<!--meta block=description-->',
        '',
        'A.',
        '',
        '## No fact',
        '',
        'Lost.',
        '',
        '# A second title',
        '',
        'Also lost.',
        '',
        '## Second',
        '<!--meta block=explain-->',
        '',
        '**Basic.** B.',
      ].join('\n'),
    );
    expect(doc.h1).toBe('Title');
    expect(doc.intro.map((n) => n.type)).toEqual(['paragraph']);
    expect(doc.blocks.map((b) => [b.name, b.heading, b.nodes.length])).toEqual([
      ['description', 'First', 2],
      ['explain', 'Second', 2],
    ]);
    expect(blockNamed(doc, 'explain')?.heading).toBe('Second');
    expect(blockNamed(doc, 'wild')).toBeUndefined();
  });

  it('marks the nodes inside a marked region, and closes a region only on its own end', () => {
    const doc = parsePage(
      [
        '## Rel',
        '<!--meta block=relationships-->',
        '',
        '<!-- relationships:start -->',
        '',
        '<!-- tour:end -->',
        '',
        '<!-- tour:start -->',
        '',
        '**Combines with**',
        '',
        '<!-- relationships:end -->',
        '',
        'After.',
      ].join('\n'),
    );
    const nodes = (blockNamed(doc, 'relationships') as Block).nodes;
    expect(nodes.map((n) => doc.regionOf.get(n) ?? null)).toEqual([null, 'relationships', null]);
  });
});

describe('text', () => {
  it('collapses whitespace, no-break spaces included, as the HTML reader did', () => {
    expect(inline(para('a  b\n c'))).toBe('a b c');
    expect(inlineOf(para('**x** y').children.slice(1))).toBe('y');
    expect(mdPlain('')).toBe('');
    expect(mdPlain('1. A [link](x.md) and `code`')).toBe('1. A link and code');
  });
});

describe('links and clicks', () => {
  const doc = parsePage(
    [
      '## D',
      '<!--meta block=description-->',
      '',
      'See [a](./a.md) and [b](./b.md).',
      '',
      '```mermaid',
      'flowchart LR',
      '  click X "/x.html"',
      '```',
      '',
      '## S',
      '<!--meta block=siblings-->',
      '',
      '- [Sib](./sib.md) — a row.',
      '',
      'Prose after the rows, with [c](./c.md).',
      '',
      '## R',
      '<!--meta block=relationships-->',
      '',
      '<!-- relationships:start -->',
      '',
      '- [Rel](./rel.md) — typed.',
      '',
      '<!-- relationships:end -->',
    ].join('\n'),
  );

  it('reads prose links outside the typed carriers', () => {
    expect(proseLinks(doc)).toEqual(['./a.md', './b.md', './c.md']);
    expect(linksIn(doc.tree)).toEqual(['./a.md', './b.md', './sib.md', './c.md', './rel.md']);
  });

  it('reads mermaid click targets', () => {
    expect(clickTargets(doc)).toEqual(['/x.html']);
  });
});

describe('rich', () => {
  it('escapes text and keeps code, bold, links, breaks and raw html as markup', () => {
    const p = para('a & 1 < 2 `c<d>` **e** [f](g.md) h\\\ni <sup>2</sup> *j*');
    expect(rich(p.children)).toBe('a &amp; 1 &lt; 2 <code>c&lt;d&gt;</code> <strong>e</strong> <a href="g.md">f</a> h<br>i <sup>2</sup> j');
    expect(rich([{ type: 'image', url: 'x', alt: 'y' } as PhrasingContent])).toBe('');
  });
});

describe('writer-owned blocks', () => {
  it('answers null when the page has no such block', () => {
    const doc = parsePage('## D\n<!--meta block=description-->\n\nText.\n');
    expect(wildItems(doc)).toBeNull();
    expect(productionItems(doc)).toBeNull();
    expect(explainItems(doc)).toBeNull();
  });

  it('dumps the explain block as its paragraph and its example, prose or sketch', () => {
    const head = '## E\n<!--meta block=explain-->\n\nThe *gate* in front.\n\n';
    expect(explainItems(parsePage(`${head}**Example.** Checkout calls it.\n`))).toEqual({ text: 'The gate in front.', example: 'Checkout calls it.' });
    expect(explainItems(parsePage(`${head}\`\`\`typescript caption="How?"\nconst a = 1;\n\`\`\`\n`))).toEqual({
      text: 'The gate in front.',
      example: 'const a = 1;',
      exampleLang: 'typescript',
      exampleCaption: 'How?',
    });
    expect(explainItems(parsePage(`${head}\`\`\`\nbare\n\`\`\`\n`))).toEqual({ text: 'The gate in front.', example: 'bare', exampleLang: '' });
    expect(explainItems(parsePage('## E\n<!--meta block=explain-->\n\nAlone.\n'))).toEqual({ text: 'Alone.', example: '' });
    expect(explainItems(parsePage('## E\n<!--meta block=explain-->\n\n- a list\n'))).toEqual({ text: '', example: '' });
  });

  it('reads a paragraph holding a leaf other than text (a hard break) as the words around it', () => {
    expect(explainItems(parsePage('## E\n<!--meta block=explain-->\n\nOne  \ntwo.\n'))?.text).toBe('One two.');
  });

  it('reads an image in the paragraph as its alt text, since it has no children to walk', () => {
    expect(explainItems(parsePage('## E\n<!--meta block=explain-->\n\nSee ![the gate](gate.svg) here.\n'))?.text).toBe('See the gate here.');
  });

  it('dumps the costs list beside the paragraph, and keeps a link as `[label](target)`', () => {
    const doc = parsePage(
      [
        '## E',
        '<!--meta block=explain-->',
        '',
        'A [breaker **gate**](./breaker.md) in front.',
        '',
        '- **Latency.** One more hop, with `code`.',
        '- Plain bullet.',
        '- ```',
        '  code first',
        '  ```',
        '',
        '**Example.** Checkout calls it.',
        '',
      ].join('\n'),
    );
    expect(explainItems(doc)).toEqual({
      text: 'A [breaker gate](./breaker.md) in front.',
      costs: [
        { lead: 'Latency.', note: 'One more hop, with code.' },
        { lead: '', note: 'Plain bullet.' },
        { lead: '', note: '' },
      ],
      example: 'Checkout calls it.',
    });
  });

  it('keeps a link in a cost note as `[label](target)`, as in the paragraph, and a bracket that is no link as the text it is', () => {
    const doc = parsePage(
      [
        '## E',
        '<!--meta block=explain-->',
        '',
        'A gate in front.',
        '',
        '- **Hand-off.** Use the [outbox](../x/outbox.md), then [retry **twice**](./retry.md#why).',
        '- **Lead.** [Starts](./s.md) with a link,',
        '  and breaks the line.',
        '- **Notation.** Write \\[n\\] and \\[a\\](b c) as text.',
        '- [Bare](./b.md) bullet, no lead.',
        '',
        '**Example.** Checkout calls it.',
        '',
      ].join('\n'),
    );
    expect(explainItems(doc)?.costs).toEqual([
      { lead: 'Hand-off.', note: 'Use the [outbox](../x/outbox.md), then [retry twice](./retry.md#why).' },
      { lead: 'Lead.', note: '[Starts](./s.md) with a link, and breaks the line.' },
      { lead: 'Notation.', note: 'Write [n] and [a](b c) as text.' },
      { lead: '', note: '[Bare](./b.md) bullet, no lead.' },
    ]);
  });

  it('dumps wild items: name, note, href; an item with no id, name or paragraph still dumps', () => {
    const doc = parsePage(
      [
        '## W',
        '<!--meta block=wild-->',
        '',
        'A lead paragraph is no item.',
        '',
        '- **[Env](https://e.x) proxy** — Two children in the bold. {#wild-env}',
        '- Plain words.',
        '- ```',
        '  code first',
        '  ```',
      ].join('\n'),
    );
    expect(wildItems(doc)).toEqual([
      { id: 'env', name: '<a href="https://e.x">Env</a> proxy', note: 'Two children in the bold.' },
      { id: '', name: '', note: 'Plain words.' },
      { id: '', name: '', note: '' },
    ]);
  });

  it('dumps the production groups, skipping a group with no known polarity', () => {
    const doc = parsePage(
      [
        '## P',
        '<!--meta block=production-->',
        '',
        '- An item before any group.',
        '',
        '### Knobs',
        '<!--meta polarity=knob-->',
        '',
        '- **K** — note',
        '- **Bare**',
        '- **C** `code` first',
        '- ```',
        '  x',
        '  ```',
        '',
        '### Something else',
        '',
        '- ignored',
        '',
        '### Checklist',
        '<!--meta polarity=check-->',
        '',
        '- gate',
      ].join('\n'),
    );
    expect(productionItems(doc)).toEqual({
      knobs: [
        { label: 'K', note: 'note' },
        { label: 'Bare', note: '' },
        { label: 'C', note: '<code>code</code> first' },
        { label: '', note: '' },
      ],
      signals: [],
      failures: [],
      checklist: [{ text: 'gate' }],
    });
  });
});
