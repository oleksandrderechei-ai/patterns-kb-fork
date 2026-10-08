/**
 * The writer-owned blocks as markdown: the dialect's shape, and what a reader
 * of the dialect gets back from it — ids, groups, text.
 */

import { describe, expect, it } from 'vitest';

import { deriveElements, parseKb } from '../lib/kb-attrs.js';

import { explainLines, productionLines, wildLines } from './blocks.js';
import { linksIn } from './page.js';

/** id, polarity and text of every element with an id. */
const read = (lines: readonly string[]): string[][] =>
  deriveElements(parseKb(lines.join('\n')).tree)
    .filter((e) => e.id !== undefined)
    .map((e) => [e.id as string, e.polarity ?? '', e.text]);

describe('explainLines', () => {
  it('writes one paragraph, then the labelled example, in the dialect of D-50', () => {
    const lines = explainLines('Explained', { text: 'A *fuse* in front.', example: 'Checkout {x}' });
    expect(lines).toEqual([
      '## Explained',
      '<!--meta block=explain-->',
      '',
      'A \\*fuse\\* in front.',
      '',
      '**Example.** Checkout \\{x}',
    ]);
    expect(read(lines)).toEqual([
      ['explain', '', 'Explained'],
      ['explain-text', '', 'A *fuse* in front.'],
      ['explain-example', '', 'Example. Checkout {x}'],
    ]);
  });

  it('writes a costs list between the paragraph and the example, ids in the dialect, a link in the paragraph', () => {
    const lines = explainLines('Explained', {
      text: 'A [fuse](./fuse.md) in front.',
      costs: [
        { lead: 'Latency.', note: 'One more *hop*.' },
        { lead: 'Upkeep.', note: 'Someone owns it.' },
      ],
      example: 'Checkout',
    });
    expect(lines.slice(3)).toEqual(['A [fuse](./fuse.md) in front.', '', '- **Latency.** One more \\*hop\\*.', '- **Upkeep.** Someone owns it.', '', '**Example.** Checkout']);
    expect(read(lines).map((r) => r[0])).toEqual(['explain', 'explain-text', 'explain-li-1', 'explain-li-2', 'explain-example']);
    expect(explainLines('E', { text: 't', costs: [], example: 'x' })).toEqual(explainLines('E', { text: 't', example: 'x' }));
  });

  it('writes a [label](path.md) in a cost note as a link, as in the paragraph, and keeps any other bracket as text', () => {
    const lines = explainLines('Explained', {
      text: 'A [fuse](./fuse.md) in front.',
      costs: [
        { lead: 'Upkeep.', note: 'Someone owns the [fuse](./fuse.md), and [Retry](../r.md#why) too.' },
        { lead: 'Notation.', note: 'Write [n], [a](b c) and [](x.md) as text, with `ticks` and *stars* literal.' },
        { lead: '[Lead](./l.md).', note: '[Starts](./s.md) with a link.' },
      ],
      example: 'Checkout',
    });
    expect(lines.slice(5, 8)).toEqual([
      '- **Upkeep.** Someone owns the [fuse](./fuse.md), and [Retry](../r.md#why) too.',
      '- **Notation.** Write \\[n\\], \\[a\\](b c) and \\[\\](x.md) as text, with \\`ticks\\` and \\*stars\\* literal.',
      // A lead is plain text: only a note carries a link.
      '- **\\[Lead\\](./l.md).** [Starts](./s.md) with a link.',
    ]);
    const tree = parseKb(lines.join('\n')).tree;
    expect(linksIn(tree)).toEqual(['./fuse.md', './fuse.md', '../r.md#why', './s.md']);
    expect(read(lines).filter((r) => (r[0] as string).startsWith('explain-li')).map((r) => r[2])).toEqual([
      'Upkeep. Someone owns the fuse, and Retry too.',
      'Notation. Write [n], [a](b c) and [](x.md) as text, with `ticks` and *stars* literal.',
      '[Lead](./l.md). Starts with a link.',
    ]);
  });

  it('guards a paragraph whose text ends in a brace group', () => {
    expect(explainLines('E', { text: 'Use {id}', example: 'b' })[3]).toBe('Use \\{id}');
  });

  it('writes a sketch example as a captioned fence, newlines kept', () => {
    const lines = explainLines('Explained', { text: 'Gate.', example: 'const a = 1;\nconst b = 2;\n', exampleLang: 'typescript', exampleCaption: 'How does it look?' });
    expect(lines.slice(3)).toEqual(['Gate.', '', '```typescript caption="How does it look?"', 'const a = 1;', 'const b = 2;', '```']);
    expect(read(lines).map((r) => r[0])).toEqual(['explain', 'explain-text', 'explain-example']);
  });

  it('writes a sketch with no caption as a bare language, and opens a longer fence around backticks', () => {
    expect(explainLines('E', { text: 't', example: 'x', exampleLang: 'text' }).slice(5)).toEqual(['```text', 'x', '```']);
    expect(explainLines('E', { text: 't', example: 'a ``` b', exampleLang: 'text' }).slice(5)).toEqual(['````text', 'a ``` b', '````']);
  });
});

describe('wildLines', () => {
  it('writes each example with its keyed id, and a link inside the bold when it has one', () => {
    const lines = wildLines('In the wild', [
      { id: 'opossum', name: 'opossum', note: 'Node: <code>errorThresholdPercentage</code> &amp; more.' },
      { id: 'hystrix', name: 'Hystrix', note: 'The JVM one.', href: 'https://github.com/Netflix/Hystrix' },
      { id: 'basic-one', name: '1. First', note: '- dash' },
    ]);
    expect(lines).toEqual([
      '## In the wild',
      '<!--meta block=wild-->',
      '',
      '- **opossum** — Node: `errorThresholdPercentage` & more. {#wild-opossum}',
      '- **[Hystrix](https://github.com/Netflix/Hystrix)** — The JVM one. {#wild-hystrix}',
      '- **1\\. First** — \\- dash {#wild-basic-one}',
    ]);
    expect(read(lines).slice(1)).toEqual([
      ['wild-opossum', '', 'opossum — Node: errorThresholdPercentage & more.'],
      ['wild-hystrix', '', 'Hystrix — The JVM one.'],
      ['wild-basic-one', '', '1. First — - dash'],
    ]);
  });

  it('writes no dash when an example has no note', () => {
    expect(wildLines('W', [{ id: 'x', name: 'X', note: '' }])[3]).toBe('- **X** {#wild-x}');
  });
});

describe('productionLines', () => {
  it('writes a group per non-empty list under its polarity fact, labelled items and bare gates', () => {
    const lines = productionLines('In production', [
      { polarity: 'knob', heading: 'Tuning knobs', items: [{ label: 'Threshold', note: 'When it opens (<code>n</code>).' }, { label: 'Window', note: 'Over time.' }] },
      { polarity: 'signal', heading: 'Signals to watch', items: [] },
      { polarity: 'check', heading: 'Readiness checklist', items: [{ text: 'Every call has a timeout' }, { text: 'Operators can force it {now}' }] },
    ]);
    expect(lines).toEqual([
      '## In production',
      '<!--meta block=production-->',
      '',
      '### Tuning knobs',
      '<!--meta polarity=knob-->',
      '',
      '- **Threshold** — When it opens (`n`).',
      '- **Window** — Over time.',
      '',
      '### Readiness checklist',
      '<!--meta polarity=check-->',
      '',
      '- Every call has a timeout',
      '- Operators can force it \\{now}',
    ]);
    expect(read(lines).slice(1)).toEqual([
      ['production-knob-1', 'knob', 'Threshold — When it opens (n).'],
      ['production-knob-2', 'knob', 'Window — Over time.'],
      ['production-check-1', 'check', 'Every call has a timeout'],
      ['production-check-2', 'check', 'Operators can force it {now}'],
    ]);
  });
});
