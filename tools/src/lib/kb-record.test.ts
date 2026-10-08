/**
 * The body of a kb-record/1 record: one node type per construct the HTML
 * renders differently, every key present, ids and anchors in document order,
 * the markdown of a node cut from the source and the words of it read the way
 * the HTML shows them. The last groups run the builder over every page under
 * docs/ and hold it to `deriveElements` (the property the parity gate between
 * the record, the site and the `.md` sibling relies on) and to the HTML the
 * site's own markdown plugins and section pass make of the same page.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFragment } from 'parse5';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { linksIn, parsePage, stripFrontmatter } from '../kb/page.js';
import { sectionMeta, type PageError } from '../site/site-portable.js';

import { REAL_TREE_TIMEOUT } from './fixtures.js';
import { deriveElements, parseKb, plainText, type Nodes, type Root } from './kb-attrs.js';
import {
  anchorsOf,
  buildBody,
  clicksIn,
  fingerprint,
  flatten,
  RecordError,
  serialize,
  type Block,
  type Body,
  type BodyNode,
  type FlatElement,
  type Inline,
  type Item,
} from './kb-record.js';
import { rehypeKbTables, remarkKbSite } from './site-markdown.js';

/** The page a link names: the slug of a relative `.md` target, none for an address elsewhere. */
function target(href: string): string | null {
  const bare = (href.split('#')[0] as string).split('?')[0] as string;
  if (/^[a-z]+:|^\/\//i.test(bare) || !bare.endsWith('.md')) return null;
  return path.posix.basename(bare, '.md');
}

/** A page as `parseKb` reads it, and the body built from it. */
function parse(md: string): { tree: Root; body: Body } {
  const { tree } = parseKb(md);
  return { tree, body: buildBody(tree, md, { linkTarget: target }) };
}

const bodyOf = (md: string): Body => parse(md).body;

/** U+00A0, written by its code so that no editor can turn it into a plain space. */
const NBSP = String.fromCodePoint(0xa0);

/** One block: its heading, its fact and a blank line, then the lines. */
const block = (name: string, ...lines: string[]): string[] => [`## ${name.toUpperCase()}`, `<!--meta block=${name}-->`, '', ...lines, ''];

/** A page: a title and one intro line, then the blocks. */
const page = (...blocks: string[][]): string => `${['# Title', '', 'Intro.', '', ...blocks.flat()].join('\n')}\n`;

/** The one block of a page with one block. */
function only(md: string): Block {
  const { blocks } = bodyOf(md);
  expect(blocks).toHaveLength(1);
  return blocks[0] as Block;
}

/** A node, checked to be of the type the test expects. */
function as<T extends BodyNode['type']>(n: BodyNode | undefined, type: T): Extract<BodyNode, { type: T }> {
  expect(n?.type).toBe(type);
  return n as Extract<BodyNode, { type: T }>;
}

/** The nth item of a list. */
function itemOf(list: Extract<BodyNode, { type: 'list' }>, n: number): Item {
  const item = list.items[n];
  expect(item).toBeDefined();
  return item as Item;
}

/** The object a JSON Pointer names in a body. */
function resolve(root: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], root);
}

/** `deriveElements` as the invariant reads it: the ids and their texts. */
const elementsOf = (tree: Root): FlatElement[] =>
  deriveElements(tree).flatMap((e) => (e.id === undefined ? [] : [{ id: e.id, text: e.text }]));

/** A page holding one of everything the dialect writes, and a few things it does not. */
const EVERYTHING = page(
  block('description', 'One **bold** paragraph with `code`.'),
  block('explain', 'The explanation, linked to [a term](term.md).', '', '- **Costs.** One cost.', '', '**Example.** The example.'),
  block(
    'structure',
    '~~~mermaid caption="How does `x` work?" wide=true',
    'flowchart LR',
    '    A --> B',
    '    click A "other.md#part"',
    '~~~',
    '',
    '```mermaid',
    'flowchart LR',
    '    A --> B',
    '```',
  ),
  block('tradeoffs', '### Pros', '<!--meta polarity=pro-->', '', '- **Fast** — quick.', '- Keyed {#tradeoffs-keyed}', '', '### Cons', '<!--meta polarity=con-->', '', '1. Slow.'),
  block('usage', '### Reach', '<!--meta polarity=when-->', '', '- When.', '', '### Avoid', '<!--meta polarity=avoid-->', '', '- Avoid.', '', 'After the columns.'),
  block('sizing', '| a | b |', '|:--|--:|', '| 1 | 2 {#sizing-row-keyed}', '| 3 | 4 |', '', '{#sizing-table}'),
  block('deepdives', '### One dive', '', 'Para.', '', '#### Deeper'),
  block(
    'sketch',
    '```ts summary="TS — a sketch"',
    'const x = 1;',
    '```',
    '',
    '```ts caption="A captioned fence"',
    'const y = 2;',
    '```',
    '',
    '```',
    'const z = 3;',
    '```',
    '',
    '> **Why?**',
    '>',
    '> Because.',
    '',
    '> ***',
    '>',
    '> No summary.',
    '',
    '> A plain quote.',
    '',
    '- [ ] todo',
    '- [x] done',
    '  - nested',
    '',
    '<div>raw</div>',
    '',
    '---',
  ),
  block(
    'relationships',
    '<!-- relationships:start -->',
    '',
    '<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->',
    '',
    '**Combines with**',
    '',
    '- [Other](other.md) — note {#rel-x}',
    '',
    '<!-- relationships:end -->',
  ),
);

describe('fingerprint', () => {
  it('is the first eight hex digits of the SHA-256 of the folded text', () => {
    expect(fingerprint('hello world')).toBe('b94d27b9');
    expect(fingerprint('')).toBe('e3b0c442');
  });

  it('folds case, every run of whitespace, a no-break space and Unicode composition', () => {
    expect(fingerprint('  Hello \n\t WORLD ')).toBe(fingerprint('hello world'));
    expect(fingerprint('hello' + NBSP + 'world')).toBe(fingerprint('hello world'));
    expect(fingerprint('caf' + String.fromCodePoint(0xe9))).toBe(fingerprint('cafe' + String.fromCodePoint(0x301)));
    expect(fingerprint('hello world!')).not.toBe(fingerprint('hello world'));
  });
});

describe('serialize', () => {
  it('prints two-space JSON in the order given, with one newline at the end', () => {
    expect(serialize({ b: [1, null], a: { c: true } })).toBe('{\n  "b": [\n    1,\n    null\n  ],\n  "a": {\n    "c": true\n  }\n}\n');
  });
});

describe('clicksIn', () => {
  it('reads the node and the target of every click line, in order', () => {
    expect(clicksIn('flowchart LR\n  A --> B\n  click A "/a.html"\n  click B_2 "b.md#x" "tip"\n')).toEqual([
      { node: 'A', href: '/a.html' },
      { node: 'B_2', href: 'b.md#x' },
    ]);
    expect(clicksIn('flowchart LR\n  A --> B\n')).toEqual([]);
  });
});

describe('the page', () => {
  it('consumes the title and holds what sits above the first block as the intro', () => {
    const body = bodyOf(page(block('description', 'Text.')));
    expect(body.intro).toEqual([{ type: 'paragraph', id: null, fp: null, text: 'Intro.', md: 'Intro.' }]);
    expect(body.blocks.map((b) => b.name)).toEqual(['description']);
  });

  it('names a block by its fact and keeps its heading as words and as markdown', () => {
    const b = only('# T\n\nIntro.\n\n## What `x` is\n<!--meta block=description-->\n\nText.\n');
    expect(b).toEqual({
      id: 'description',
      name: 'description',
      heading: { text: 'What x is', md: 'What `x` is' },
      generated: null,
      content: [{ type: 'paragraph', id: 'description-p-1', fp: fingerprint('Text.'), text: 'Text.', md: 'Text.' }],
    });
  });

  it('is a page of its own when it has no block: the headings stay headings', () => {
    const body = bodyOf('# One\n\nIntro.\n\n## Part\n\nWords.\n\n# Two\n');
    expect(body.blocks).toEqual([]);
    expect(body.intro).toEqual([
      { type: 'paragraph', id: null, fp: null, text: 'Intro.', md: 'Intro.' },
      { type: 'heading', id: null, fp: null, depth: 2, text: 'Part', md: 'Part' },
      { type: 'paragraph', id: null, fp: null, text: 'Words.', md: 'Words.' },
      { type: 'heading', id: null, fp: null, depth: 1, text: 'Two', md: 'Two' },
    ]);
  });

  it('has no title to consume on a page that starts with its intro', () => {
    expect(bodyOf('Just text.\n').intro).toEqual([{ type: 'paragraph', id: null, fp: null, text: 'Just text.', md: 'Just text.' }]);
  });

  it('refuses a heading with no block fact once a block has begun', () => {
    const md = page(block('description', 'Text.'), ['## Loose', '', 'More.']);
    expect(() => bodyOf(md)).toThrow(RecordError);
    expect(() => bodyOf(md)).toThrow('line 10: a heading of depth 2 with no block fact comes after the "description" block');
  });

  it('refuses a second title once a block has begun', () => {
    expect(() => bodyOf(page(block('description', 'Text.'), ['# Again']))).toThrow('a heading of depth 1 with no block fact');
  });
});

describe('every node', () => {
  it('has every key, in the order its interface lists them', () => {
    const { body } = parse(EVERYTHING);
    const nodes = body.blocks.flatMap((b) => b.content);
    const keys = new Map<string, string[]>();
    const take = (n: { type: string }): void => {
      if (!keys.has(n.type)) keys.set(n.type, Object.keys(n));
    };
    nodes.forEach(take);
    expect(Object.keys(body)).toEqual(['intro', 'blocks', 'anchors', 'links']);
    expect(Object.keys(body.blocks[0] as Block)).toEqual(['id', 'name', 'heading', 'generated', 'content']);
    expect(Object.keys((body.blocks[0] as Block).heading)).toEqual(['text', 'md']);
    expect(keys.get('paragraph')).toEqual(['type', 'id', 'fp', 'text', 'md']);
    expect(keys.get('heading')).toEqual(['type', 'id', 'fp', 'depth', 'text', 'md']);
    expect(keys.get('group')).toEqual(['type', 'fact', 'value', 'heading', 'content']);
    expect(keys.get('list')).toEqual(['type', 'id', 'fp', 'ordered', 'start', 'items']);
    expect(keys.get('table')).toEqual(['type', 'id', 'fp', 'align', 'header', 'rows']);
    expect(keys.get('figure')).toEqual(['type', 'id', 'fp', 'lang', 'caption', 'wide', 'code']);
    expect(keys.get('sketch')).toEqual(['type', 'id', 'fp', 'form', 'lang', 'summary', 'caption', 'wide', 'code', 'content']);
    expect(keys.get('code')).toEqual(['type', 'id', 'fp', 'lang', 'code']);
    expect(keys.get('quote')).toEqual(['type', 'id', 'fp', 'content']);
    expect(keys.get('html')).toEqual(['type', 'md']);
    const group = nodes.find((n) => n.type === 'group');
    const list = as(group?.type === 'group' ? group.content[0] : undefined, 'list');
    expect(Object.keys(group?.type === 'group' ? group.heading : {})).toEqual(['id', 'fp', 'text', 'md']);
    expect(Object.keys(list.items[0] as object)).toEqual(['id', 'fp', 'text', 'md', 'lead', 'checked', 'content']);
    const table = as(
      nodes.find((n) => n.type === 'table'),
      'table',
    );
    expect(Object.keys(table.rows[0] as object)).toEqual(['id', 'fp', 'cells']);
    expect(Object.keys(table.header[0] as object)).toEqual(['text', 'md']);
    expect(Object.keys((body.links[0] ?? {}) as object)).toEqual(['block', 'from', 'via', 'text', 'href', 'to', 'fragment']);
  });

  it('gives fp exactly when it has an id', () => {
    const seen: { id: string | null; fp: string | null }[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        const o = value as Record<string, unknown>;
        if ('fp' in o) seen.push({ id: o['id'] as string | null, fp: o['fp'] as string | null });
        Object.values(o).forEach(walk);
      }
    };
    const { body } = parse(EVERYTHING);
    walk([body.intro, body.blocks]);
    expect(seen.length).toBeGreaterThan(20);
    for (const s of seen) expect(s.fp === null).toBe(s.id === null);
    expect(seen.some((s) => s.id === null)).toBe(true);
    expect(seen.some((s) => s.id !== null)).toBe(true);
  });
});

describe('paragraphs and text', () => {
  it('keeps code spans, links and bold in md but not in text', () => {
    const b = only(page(block('description', 'Use `code`, [a link](x.md#y) and **bold**.')));
    expect(as(b.content[0], 'paragraph')).toMatchObject({
      text: 'Use code, a link and bold.',
      md: 'Use `code`, [a link](x.md#y) and **bold**.',
    });
  });

  it('keeps a no-break space in text, as the entity it was written in md', () => {
    const p = as(only(page(block('description', 'Wait 5&nbsp;ms, then  go.'))).content[0], 'paragraph');
    expect(p.text).toBe('Wait 5' + NBSP + 'ms, then go.');
    expect(p.md).toBe('Wait 5&nbsp;ms, then  go.');
  });

  it('keeps an escape, and an escaped brace that no suffix can be', () => {
    const p = as(only(page(block('description', 'A \\*star\\* and \\{#not-an-id}'))).content[0], 'paragraph');
    expect(p.text).toBe('A *star* and {#not-an-id}');
    expect(p.md).toBe('A \\*star\\* and \\{#not-an-id}');
    expect(p.id).toBe('description-p-1');
  });

  it('takes an explicit id as the id, with no number, and removes the suffix from md', () => {
    const b = only(page(block('description', 'First.', '', 'Second {#description-keyed}', '', 'Third.')));
    expect(b.content.map((n) => (n.type === 'paragraph' ? [n.id, n.text, n.md] : n.type))).toEqual([
      ['description-p-1', 'First.', 'First.'],
      ['description-keyed', 'Second', 'Second'],
      ['description-p-2', 'Third.', 'Third.'],
    ]);
  });

  it('removes a suffix that follows markup as well as one that follows plain text', () => {
    const b = only(page(block('description', 'A **bold** {#one}', '', 'A `code` {#two}', '', 'Plain {#three}')));
    expect(b.content.map((n) => (n.type === 'paragraph' ? n.md : ''))).toEqual(['A **bold**', 'A `code`', 'Plain']);
  });

  it('leaves a brace group the grammar refuses where the author put it', () => {
    const p = as(only(page(block('description', 'See {not an id}'))).content[0], 'paragraph');
    expect(p).toMatchObject({ id: 'description-p-1', text: 'See {not an id}', md: 'See {not an id}' });
  });

  it('cuts a paragraph that is a hard break from its source, without a container prefix', () => {
    const root = as(only(page(block('description', 'First\\', 'Second'))).content[0], 'paragraph');
    expect(root.md).toBe('First\\\nSecond');
    expect(root.text).toBe('First Second');
    const quote = as(only(page(block('selfcheck', '> **Q?**', '>', '> First\\', '> second\\', 'lazy {#selfcheck-lazy}'))).content[0], 'sketch');
    expect(as(quote.content[0], 'paragraph').md).toBe('First\\\nsecond\\\nlazy');
    const item = as(only(page(block('description', '- First\\', '  second', '    deeper'))).content[0], 'list').items[0] as { md: string };
    expect(item.md).toBe('First\\\nsecond\n  deeper');
  });

  it('fingerprints the words of a node', () => {
    const p = as(only(page(block('description', 'The  words.'))).content[0], 'paragraph');
    expect(p.fp).toBe(fingerprint('the words.'));
  });
});

describe('headings', () => {
  it('keeps a heading that is no group as a flat heading with the id it was given', () => {
    const b = only(page(block('deepdives', '### One dive', '', '#### Deeper {#deepdives-h-deeper}', '', 'Text.')));
    expect(b.content).toEqual([
      { type: 'heading', id: 'deepdives-dive-1', fp: fingerprint('One dive'), depth: 3, text: 'One dive', md: 'One dive' },
      { type: 'heading', id: 'deepdives-h-deeper', fp: fingerprint('Deeper'), depth: 4, text: 'Deeper', md: 'Deeper' },
      { type: 'paragraph', id: 'deepdives-p-1', fp: fingerprint('Text.'), text: 'Text.', md: 'Text.' },
    ]);
  });
});

describe('groups', () => {
  const trade = page(
    block(
      'tradeoffs',
      '### Pros',
      '<!--meta polarity=pro-->',
      '',
      '- **Stops cascades** — one slow call no longer spreads.',
      '- Gives space to recover {#tradeoffs-keyed}',
      '- Third.',
      '',
      '### Cons',
      '<!--meta polarity=con-->',
      '',
      '- Costs [a link](x.md).',
    ),
  );

  it('holds a polarity group in its fact, with the ids of its items numbered per polarity', () => {
    const b = only(trade);
    const pros = as(b.content[0], 'group');
    expect(pros).toMatchObject({ type: 'group', fact: 'polarity', value: 'pro', heading: { id: null, fp: null, text: 'Pros', md: 'Pros' } });
    const list = as(pros.content[0], 'list');
    expect(list).toMatchObject({ id: null, fp: null, ordered: false, start: null });
    expect(list.items.map((i) => i.id)).toEqual(['tradeoffs-pro-1', 'tradeoffs-keyed', 'tradeoffs-pro-2']);
    expect(list.items[0]).toEqual({
      id: 'tradeoffs-pro-1',
      fp: fingerprint('Stops cascades — one slow call no longer spreads.'),
      text: 'Stops cascades — one slow call no longer spreads.',
      md: '**Stops cascades** — one slow call no longer spreads.',
      lead: 'Stops cascades',
      checked: null,
      content: [],
    });
    expect(list.items[1]).toMatchObject({ text: 'Gives space to recover', md: 'Gives space to recover', lead: null });
    const cons = as(b.content[1], 'group');
    expect(cons).toMatchObject({ fact: 'polarity', value: 'con' });
    expect(as(cons.content[0], 'list').items[0]).toMatchObject({ id: 'tradeoffs-con-1', md: 'Costs [a link](x.md).' });
  });

  it('closes a polarity group after its last list when prose follows, and hands the prose to the block (X-06)', () => {
    const b = only(
      page(
        block(
          'usage',
          '### Reach for it when',
          '<!--meta polarity=when-->',
          '',
          '- When.',
          '',
          '### Avoid when',
          '<!--meta polarity=avoid-->',
          '',
          'A lead sentence.',
          '',
          '- Avoid.',
          '',
          'Between.',
          '',
          '- Avoid too.',
          '',
          'Without it, everything freezes.',
          '',
          '#### A deeper heading',
        ),
      ),
    );
    expect(b.content.map((n) => n.type)).toEqual(['group', 'group', 'paragraph', 'heading']);
    const avoid = as(b.content[1], 'group');
    expect(avoid.content.map((n) => n.type)).toEqual(['paragraph', 'list', 'paragraph', 'list']);
    expect(as(b.content[2], 'paragraph')).toMatchObject({ id: 'usage-p-3', text: 'Without it, everything freezes.' });
    expect(as(avoid.content[0], 'paragraph').id).toBe('usage-p-1');
    expect(as(b.content[3], 'heading')).toMatchObject({ depth: 4, id: null });
    const { anchors } = bodyOf(
      page(block('usage', '### Avoid when', '<!--meta polarity=avoid-->', '', '- Avoid.', '', 'After.')),
    );
    expect(anchors['usage-avoid-1']).toBe('/blocks/0/content/0/content/0/items/0');
    expect(anchors['usage-p-1']).toBe('/blocks/0/content/1');
  });

  it('keeps everything in a polarity group that ends in its list, or in what shows nothing', () => {
    const quiet = only(
      page(block('usage', '### Avoid when', '<!--meta polarity=avoid-->', '', '- Avoid.', '', '<!-- a note -->', '', '[ref]: https://example.com')),
    );
    expect(quiet.content.map((n) => n.type)).toEqual(['group']);
    expect(as(quiet.content[0], 'group').content.map((n) => n.type)).toEqual(['list']);
  });

  it('keeps everything in a polarity group that has no list', () => {
    const b = only(page(block('usage', '### Avoid when', '<!--meta polarity=avoid-->', '', 'Only words.', '', 'More words.')));
    expect(b.content.map((n) => n.type)).toEqual(['group']);
    expect(as(b.content[0], 'group').content).toHaveLength(2);
  });

  it('keeps the prose after a requirements list in its group', () => {
    const b = only(
      page(
        block(
          'requirements',
          '### Functional',
          '<!--meta requirement=fr-->',
          '',
          '3. Submit a URL.',
          '4. Get a short one.',
          '',
          'Out of scope: accounts.',
          '',
          '### Non-functional',
          '<!--meta requirement=nfr-->',
          '',
          '- **Scale** — a lot.',
        ),
      ),
    );
    expect(b.content.map((n) => n.type)).toEqual(['group', 'group']);
    const fr = as(b.content[0], 'group');
    expect(fr).toMatchObject({ fact: 'requirement', value: 'fr' });
    expect(fr.content.map((n) => n.type)).toEqual(['list', 'paragraph']);
    const list = as(fr.content[0], 'list');
    expect(list).toMatchObject({ ordered: true, start: 3 });
    expect(list.items.map((i) => i.id)).toEqual(['requirements-fr-1', 'requirements-fr-2']);
    expect(as(fr.content[1], 'paragraph')).toMatchObject({ id: 'requirements-p-1', text: 'Out of scope: accounts.' });
    expect(as(as(b.content[1], 'group').content[0], 'list').items[0]).toMatchObject({ id: 'requirements-nfr-1', lead: 'Scale' });
  });

  it('gives a group heading the id it carries, and anchors it', () => {
    const { body } = parse(page(block('usage', '### Avoid when {#usage-h-avoid}', '<!--meta polarity=avoid-->', '', '- Avoid.')));
    const group = as(body.blocks[0]?.content[0], 'group');
    expect(group.heading).toEqual({ id: 'usage-h-avoid', fp: fingerprint('Avoid when'), text: 'Avoid when', md: 'Avoid when' });
    expect(body.anchors['usage-h-avoid']).toBe('/blocks/0/content/0/heading');
  });

  it('reads a polarity before a requirement when a heading carries both, and neither on another depth', () => {
    const both = only(page(block('usage', '### Both', '<!--meta polarity=pro requirement=fr-->', '', '- One.')));
    expect(as(both.content[0], 'group')).toMatchObject({ fact: 'polarity', value: 'pro' });
    const deeper = only(page(block('usage', '#### Four', '<!--meta polarity=pro-->', '', '- One.')));
    expect(deeper.content.map((n) => n.type)).toEqual(['heading', 'list']);
  });
});

describe('lists', () => {
  it('reads a task list with its state, its lead and what sits inside an item', () => {
    const b = only(
      page(
        block(
          'description',
          '- [ ] **Open** — to do',
          '- [x] done',
          '  - nested **b** {#nested-b}',
          '',
          '  A second paragraph.',
          '',
          '  ```ts',
          '  const a = 1;',
          '  ```',
          '- plain',
        ),
      ),
    );
    const list = as(b.content[0], 'list');
    expect(list.items.map((i) => [i.checked, i.lead, i.text, i.md])).toEqual([
      [false, 'Open', 'Open — to do', '**Open** — to do'],
      [true, null, 'done', 'done'],
      [null, null, 'plain', 'plain'],
    ]);
    const done = itemOf(list, 1);
    expect(done.content.map((n) => n.type)).toEqual(['list', 'paragraph', 'code']);
    expect(itemOf(as(done.content[0], 'list'), 0)).toMatchObject({ id: 'nested-b', md: 'nested **b**', lead: null });
    expect(as(done.content[1], 'paragraph')).toMatchObject({ text: 'A second paragraph.' });
    expect(as(done.content[2], 'code')).toMatchObject({ lang: 'ts', code: 'const a = 1;' });
  });

  it('anchors a nested item by its place in the record', () => {
    const { body } = parse(page(block('description', '- one', '  - two {#two}', '    - three {#three}')));
    expect(body.anchors['two']).toBe('/blocks/0/content/0/items/0/content/0/items/0');
    expect(body.anchors['three']).toBe('/blocks/0/content/0/items/0/content/0/items/0/content/0/items/0');
    expect(resolve(body, body.anchors['three'] as string)).toMatchObject({ id: 'three', text: 'three' });
  });

  it('holds an item that opens with something other than a paragraph, or with nothing at all', () => {
    const b = only(page(block('description', '- ```ts', '  x', '  ```', '-', '- > quote')));
    const list = as(b.content[0], 'list');
    const [code, empty, quote] = [0, 1, 2].map((i) => itemOf(list, i));
    expect(code).toMatchObject({ text: '', md: '', lead: null });
    expect(code?.content.map((n) => n.type)).toEqual(['code']);
    expect(empty).toMatchObject({ id: 'description-li-2', text: '', md: '', lead: null, content: [] });
    expect(quote?.content.map((n) => n.type)).toEqual(['quote']);
  });

  it('fingerprints an item with no words by the words under it, and a list by its items', () => {
    const b = only(
      page(block('description', '- > Nested quote', '', '- Second.', '', '{#description-list}')),
    );
    const list = as(b.content[0], 'list');
    expect(list.id).toBe('description-list');
    expect(list.fp).toBe(fingerprint('Nested quote\nSecond.'));
    expect(itemOf(list, 0).fp).toBe(fingerprint('Nested quote'));
  });
});

describe('tables', () => {
  const md = page(
    block(
      'sizing',
      '| Axis | `n` | Cost [x](x.md) |',
      '|:--|:-:|--:|',
      '| Writes | 5 {#kept-middle} | a \\| b |',
      '| Reads | | 7 {#sizing-row-keyed}',
      '',
      '{#sizing-table}',
    ),
  );

  it('reads the alignment, the header, the rows and their ids', () => {
    const t = as(only(md).content[0], 'table');
    expect(t.id).toBe('sizing-table');
    expect(t.fp).toBe(fingerprint('Axis\nn\nCost x\nWrites\n5 {#kept-middle}\na | b\nReads\n7'));
    expect(t.align).toEqual(['left', 'center', 'right']);
    expect(t.header).toEqual([
      { text: 'Axis', md: 'Axis' },
      { text: 'n', md: '`n`' },
      { text: 'Cost x', md: 'Cost [x](x.md)' },
    ]);
    expect(t.rows.map((r) => [r.id, r.cells.map((c) => c.md)])).toEqual([
      ['sizing-row-1', ['Writes', '5 {#kept-middle}', 'a \\| b']],
      ['sizing-row-keyed', ['Reads', '', '7']],
    ]);
    expect(t.rows[0]?.cells[2]).toEqual({ text: 'a | b', md: 'a \\| b' });
    expect(t.rows[0]?.fp).toBe(fingerprint('Writes\n5 {#kept-middle}\na | b'));
  });

  it('has no id on a table that was given none', () => {
    const t = as(only(page(block('sizing', '| a |', '|---|', '| 1 |'))).content[0], 'table');
    expect(t).toMatchObject({ id: null, fp: null, align: [null] });
    expect(t.rows[0]).toMatchObject({ id: 'sizing-row-1' });
  });
});

describe('fences', () => {
  it('reads a captioned diagram, wide, with its caption as words and as written', () => {
    const f = as(only(page(block('structure', '~~~mermaid caption="Why `x` first?" wide=true', 'flowchart LR', '    A --> B', '~~~'))).content[0], 'figure');
    expect(f).toEqual({
      type: 'figure',
      id: 'structure-fig-1',
      fp: fingerprint('Why x first?'),
      lang: 'mermaid',
      caption: { text: 'Why x first?', md: 'Why `x` first?' },
      wide: true,
      code: 'flowchart LR\n    A --> B',
    });
  });

  it('reads a diagram with no caption and fingerprints its source', () => {
    const f = as(only(page(block('structure', '```mermaid', 'flowchart LR', '```'))).content[0], 'figure');
    expect(f).toMatchObject({ caption: null, wide: false, fp: fingerprint('flowchart LR') });
  });

  it('reads a fence with a summary as a code sketch', () => {
    const s = as(only(page(block('sketch', '~~~ts summary="TS — a `Breaker`, small"', 'const x = 1;', '~~~'))).content[0], 'sketch');
    expect(s).toEqual({
      type: 'sketch',
      id: 'sketch-variant-1',
      fp: fingerprint('TS — a Breaker, small'),
      form: 'code',
      lang: 'ts',
      summary: { text: 'TS — a Breaker, small', md: 'TS — a `Breaker`, small' },
      caption: null,
      wide: false,
      code: 'const x = 1;',
      content: [],
    });
  });

  it('fingerprints a code sketch with an empty summary by its code', () => {
    const s = as(only(page(block('sketch', '```ts summary=""', 'const q = 1;', '```'))).content[0], 'sketch');
    expect(s).toMatchObject({ summary: { text: '', md: '' }, fp: fingerprint('const q = 1;') });
  });

  it('keeps the caption of a fence that has a summary too', () => {
    const s = as(only(page(block('sketch', '```ts summary="One" caption="Two"', 'x', '```'))).content[0], 'sketch');
    expect(s).toMatchObject({ summary: { text: 'One' }, caption: { text: 'Two', md: 'Two' } });
  });

  it('reads a captioned fence of another language as a figure', () => {
    const f = as(only(page(block('explain', 'The text.', '', '```ts caption="How does it call?"', 'call();', '```'))).content[1], 'figure');
    expect(f).toMatchObject({ id: 'explain-example', lang: 'ts', caption: { text: 'How does it call?' }, code: 'call();' });
  });

  it('reads a fence with neither as code, with no language when it names none', () => {
    const [named, bare] = only(page(block('sketch', '```bash', 'ls', '```', '', '```', 'plain', '```'))).content;
    expect(as(named, 'code')).toEqual({ type: 'code', id: 'sketch-variant-1', fp: fingerprint('ls'), lang: 'bash', code: 'ls' });
    expect(as(bare, 'code')).toMatchObject({ lang: null, code: 'plain' });
  });

  it('gives a fence above the first block no id', () => {
    expect(bodyOf('# T\n\n```ts\nx\n```\n').intro).toEqual([{ type: 'code', id: null, fp: null, lang: 'ts', code: 'x' }]);
  });

  it('takes the id a block-form suffix gave a fence', () => {
    const f = as(only(page(block('structure', '```mermaid', 'flowchart LR', '```', '', '{#structure-main}'))).content[0], 'figure');
    expect(f.id).toBe('structure-main');
  });
});

describe('blockquotes', () => {
  it('reads a quote that opens with a bold run as a prose sketch with that run as its summary', () => {
    const b = only(
      page(
        block(
          'selfcheck',
          '> **Why trip on a rate?**',
          '>',
          '> One slow call is [noise](x.md#a).',
          '',
          '> **Second?**',
          '>',
          '> Answer.',
        ),
      ),
    );
    const first = as(b.content[0], 'sketch');
    expect(first).toEqual({
      type: 'sketch',
      id: 'selfcheck-sketch-1',
      fp: fingerprint('Why trip on a rate?'),
      form: 'prose',
      lang: null,
      summary: { text: 'Why trip on a rate?', md: '**Why trip on a rate?**' },
      caption: null,
      wide: false,
      code: null,
      content: [{ type: 'paragraph', id: 'selfcheck-p-1', fp: fingerprint('One slow call is noise.'), text: 'One slow call is noise.', md: 'One slow call is [noise](x.md#a).' }],
    });
    expect(as(b.content[1], 'sketch').id).toBe('selfcheck-sketch-2');
  });

  it('reads a quote that opens with a thematic break as a prose sketch with no summary', () => {
    const s = as(only(page(block('selfcheck', '> ***', '>', '> No summary here.'))).content[0], 'sketch');
    expect(s).toMatchObject({ form: 'prose', summary: null, fp: fingerprint('No summary here.') });
    expect(s.content.map((n) => n.type)).toEqual(['paragraph']);
  });

  it('reads any other quote as a quote, with its first paragraph among its content', () => {
    const q = as(only(page(block('description', '> Just a quote.', '>', '> - with a list'))).content[0], 'quote');
    expect(q).toMatchObject({ id: 'description-sketch-1', fp: fingerprint('Just a quote.') });
    expect(q.content.map((n) => n.type)).toEqual(['paragraph', 'list']);
  });

  it('fingerprints a quote with no words of its own by what is in it, and holds an empty one', () => {
    const q = as(only(page(block('description', '> - a list', '> - of two'))).content[0], 'quote');
    expect(q.fp).toBe(fingerprint('a list\nof two'));
    const empty = as(only(page(block('description', '>'))).content[0], 'quote');
    expect(empty.content).toEqual([]);
  });
});

describe('markup the dialect gives no data to', () => {
  it('keeps raw html, a thematic break and a footnote definition as written', () => {
    const b = only(page(block('description', '<div class="x">', 'raw', '</div>', '', '---', '', '[^1]: A note.', '', 'After.')));
    expect(b.content.map((n) => (n.type === 'html' ? n.md : n.type))).toEqual(['<div class="x">\nraw\n</div>', '---', '[^1]: A note.', 'paragraph']);
  });

  it('drops comments and link reference definitions, in a block and inside an item or a quote', () => {
    const b = only(page(block('description', '<!-- note -->', '', 'Words.', '', '<!-- -->', '', '[ref]: https://example.com', '', '- item', '  <!-- inside -->', '', '> quoted', '>', '> <!-- inside -->')));
    expect(b.content.map((n) => n.type)).toEqual(['paragraph', 'list', 'quote']);
    expect(itemOf(as(b.content[1], 'list'), 0).content).toEqual([]);
    expect(as(b.content[2], 'quote').content.map((n) => n.type)).toEqual(['paragraph']);
  });

  it('keeps a raw block with a comment in it', () => {
    const b = only(page(block('description', '<!-- note --> <b>bold</b>')));
    expect(as(b.content[0], 'html').md).toBe('<!-- note --> <b>bold</b>');
  });

  it('removes a container prefix from the lines of a raw block inside a quote', () => {
    const q = as(only(page(block('description', '> <div>', '> raw', '> </div>'))).content[0], 'quote');
    expect(as(q.content[0], 'html').md).toBe('<div>\nraw\n</div>');
  });
});

describe('links', () => {
  it('notes each link with the block it sits in and the element around it', () => {
    const { links } = bodyOf(
      page(
        block('description', 'See [the con](circuit-breaker.md#tradeoffs-con-1), [a page](./other.md), [no fragment](x.md#) and [off site](https://example.com/a#b).'),
        block('variations', '- **[Fallback](fallback.md) path** — see `x` and [more](more.md#there).'),
      ),
    );
    expect(links).toEqual([
      { block: 'description', from: 'description-p-1', via: 'text', text: 'the con', href: 'circuit-breaker.md#tradeoffs-con-1', to: 'circuit-breaker', fragment: 'tradeoffs-con-1' },
      { block: 'description', from: 'description-p-1', via: 'text', text: 'a page', href: './other.md', to: 'other', fragment: null },
      { block: 'description', from: 'description-p-1', via: 'text', text: 'no fragment', href: 'x.md#', to: 'x', fragment: null },
      { block: 'description', from: 'description-p-1', via: 'text', text: 'off site', href: 'https://example.com/a#b', to: null, fragment: 'b' },
      { block: 'variations', from: 'variations-item-1', via: 'text', text: 'Fallback', href: 'fallback.md', to: 'fallback', fragment: null },
      { block: 'variations', from: 'variations-item-1', via: 'text', text: 'more', href: 'more.md#there', to: 'more', fragment: 'there' },
    ]);
  });

  it('has no block and no element for a link in the intro', () => {
    const { links } = bodyOf('# T\n\nSee [a](a.md).\n');
    expect(links).toEqual([{ block: null, from: null, via: 'text', text: 'a', href: 'a.md', to: 'a', fragment: null }]);
  });

  it('notes a link in a block heading under that block, and one in a table under its row', () => {
    const md = '# T\n\nIntro.\n\n## [Linked](h.md)\n<!--meta block=matrix-->\n\n| [head](a.md) | b |\n|---|---|\n| [cell](c.md) | d |\n';
    expect(bodyOf(md).links.map((l) => [l.block, l.from, l.text])).toEqual([
      ['matrix', null, 'Linked'],
      ['matrix', null, 'head'],
      ['matrix', 'matrix-row-1', 'cell'],
    ]);
  });

  it('notes a diagram node bound to a page by click, under the figure', () => {
    const { links } = bodyOf(
      page(block('structure', '```mermaid', 'flowchart LR', '  A --> B', '  click A "../a.md#x"', '  click B "https://example.com"', '```')),
    );
    expect(links).toEqual([
      { block: 'structure', from: 'structure-fig-1', via: 'click', text: 'A', href: '../a.md#x', to: 'a', fragment: 'x' },
      { block: 'structure', from: 'structure-fig-1', via: 'click', text: 'B', href: 'https://example.com', to: null, fragment: null },
    ]);
  });

  it('notes a click in a figure that has no id, in the intro, under no element', () => {
    const { links } = bodyOf('# T\n\n```mermaid\nflowchart LR\n  click A "a.md"\n```\n');
    expect(links).toEqual([{ block: null, from: null, via: 'click', text: 'A', href: 'a.md', to: 'a', fragment: null }]);
  });

  it('passes each href to the caller to resolve, and nothing else', () => {
    const seen: string[] = [];
    const md = page(block('description', '[a](a.md) [b](b.md#c)'));
    const { tree } = parseKb(md);
    buildBody(tree, md, { linkTarget: (href) => (seen.push(href), null) });
    expect(seen).toEqual(['a.md', 'b.md#c']);
  });
});

describe('marked regions', () => {
  const generated = page(
    block(
      'relationships',
      '<!-- relationships:start -->',
      '',
      '<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->',
      '',
      '**Combines with**',
      '',
      '- [Retry](retry.md) — note {#rel-retry}',
      '',
      '<!-- relationships:end -->',
    ),
  );

  it('marks a block a generator wrote, keeps its content and notes none of its links', () => {
    const { blocks, links, anchors } = bodyOf(generated);
    expect(blocks[0]?.generated).toBe('relationships');
    expect(blocks[0]?.content.map((n) => n.type)).toEqual(['paragraph', 'list']);
    expect(anchors['rel-retry']).toBe('/blocks/0/content/1/items/0');
    expect(links).toEqual([]);
  });

  it('holds a block a generator wrote only the end of: the hand-written part keeps its links', () => {
    const { blocks, links } = bodyOf(
      page(
        block(
          'tour',
          'A figure or a lead, written by hand, with [a link](hand.md).',
          '',
          '<!-- tour:start -->',
          '',
          '### [Step](step.md) {#tour-step}',
          '',
          'The step.',
          '',
          '<!-- tour:end -->',
        ),
      ),
    );
    expect(blocks[0]?.generated).toBe('tour');
    expect(blocks[0]?.content.map((n) => n.type)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(links.map((l) => l.to)).toEqual(['hand']);
  });

  it('marks nothing on a block with no region, and nothing on a region above the first block', () => {
    const md = '# T\n\nIntro.\n\n<!-- docs-map:start -->\n\nGenerated, with [a link](a.md).\n\n<!-- docs-map:end -->\n\n## D\n<!--meta block=description-->\n\nText.\n';
    const body = bodyOf(md);
    expect(body.blocks[0]?.generated).toBeNull();
    expect(body.intro.map((n) => (n.type === 'paragraph' ? n.text : n.type))).toEqual(['Intro.', 'Generated, with a link.']);
    expect(body.links).toEqual([]);
  });

  it.each([
    ['a region that is open at the next block', page(block('relationships', '<!-- relationships:start -->', 'text'), block('tour', '<!-- relationships:end -->')), 'the region "relationships" is still open at the "tour" block'],
    ['a region that never closes', page(block('relationships', '<!-- relationships:start -->', 'text')), 'the region "relationships" is never closed'],
    ['an end with no start', page(block('relationships', '<!-- relationships:end -->')), 'the region "relationships" ends where none of that name is open'],
    ['an end that names another region', page(block('relationships', '<!-- relationships:start -->', '<!-- tour:end -->')), 'the region "tour" ends where none of that name is open'],
    ['a region inside a region', page(block('relationships', '<!-- relationships:start -->', '<!-- tour:start -->')), 'the region "tour" starts inside the region "relationships"'],
    ['a region of another name than its block', page(block('description', '<!-- fluency:start -->', 'text', '<!-- fluency:end -->')), 'the block "description" holds the region "fluency"'],
    ['a region no generator writes, named as its block', page(block('description', '<!-- description:start -->', 'text', '<!-- description:end -->')), 'the block "description" holds the region "description"'],
    ['two regions in one block', page(block('relationships', '<!-- relationships:start -->', 'a', '<!-- relationships:end -->', '<!-- tour:start -->', 'b', '<!-- tour:end -->')), 'the block "relationships" holds the region "relationships", "tour"'],
  ])('refuses %s', (_what, md, message) => {
    expect(() => bodyOf(md)).toThrow(RecordError);
    expect(() => bodyOf(md)).toThrow(message);
  });
});

describe('ids and anchors', () => {
  it('maps every id to the object that carries it, in document order', () => {
    const { body } = parse(EVERYTHING);
    const ids = Object.keys(body.anchors);
    expect(ids).toEqual(flatten(body).map((e) => e.id));
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) expect(resolve(body, body.anchors[id] as string), id).toMatchObject({ id });
    expect(body.anchors['description']).toBe('/blocks/0');
    expect(body.anchors['sizing-row-keyed']).toBe('/blocks/5/content/0/rows/0');
  });

  it('takes the anchors of the blocks a record keeps, pointing into the record that keeps them', () => {
    const { body } = parse(EVERYTHING);
    const kept = { intro: body.intro, blocks: body.blocks.filter((b) => b.name === 'usage' || b.name === 'sizing') };
    const anchors = anchorsOf(kept);
    expect(Object.keys(anchors).filter((id) => id.startsWith('tradeoffs'))).toEqual([]);
    expect(anchors['usage']).toBe('/blocks/0');
    expect(anchors['sizing']).toBe('/blocks/1');
    for (const id of Object.keys(anchors)) expect(resolve(kept, anchors[id] as string), id).toMatchObject({ id });
    expect(anchorsOf(body)).toEqual(body.anchors);
  });

  it('refuses an id that is on two elements', () => {
    const md = page(block('description', 'One {#same}', '', 'Two {#same}'));
    expect(() => bodyOf(md)).toThrow(RecordError);
    expect(() => bodyOf(md)).toThrow('the id "same" is on two elements, /blocks/0/content/0 and /blocks/0/content/1');
  });

  it('refuses a block that is named twice, since its id is its name', () => {
    expect(() => bodyOf(page(block('description', 'A.'), block('description', 'B.')))).toThrow('the id "description" is on two elements');
  });

  it('refuses a tree that was parsed without positions', () => {
    const md = page(block('description', 'Text.'));
    const { tree } = parseKb(md);
    const strip = (n: Nodes): void => {
      delete (n as { position?: unknown }).position;
      if ('children' in n) (n.children as Nodes[]).forEach(strip);
    };
    strip(tree);
    expect(() => buildBody(tree, md, { linkTarget: target })).toThrow(RecordError);
    expect(() => buildBody(tree, md, { linkTarget: target })).toThrow('has no source position');
  });
});

describe('flatten', () => {
  it('lists every id with the text deriveElements gives its element, in the same order', () => {
    const { tree, body } = parse(EVERYTHING);
    expect(flatten(body)).toEqual(elementsOf(tree));
    const text = new Map(flatten(body).map((e) => [e.id, e.text]));
    expect(text.get('description')).toBe('DESCRIPTION');
    expect(text.get('structure-fig-1')).toBe('How does `x` work?');
    expect(text.get('structure-fig-2')).toBe('');
    expect(text.get('sizing-table')).toBe('');
    expect(text.get('sizing-row-keyed')).toBe('1 | 2');
    expect(text.get('sizing-row-1')).toBe('3 | 4');
    expect(text.get('sketch-variant-1')).toBe('TS — a sketch');
    expect(text.get('sketch-variant-2')).toBe('');
    expect(text.get('sketch-variant-3')).toBe('');
    expect(text.get('sketch-variant-4')).toBe('Why?');
    expect(text.get('sketch-variant-5')).toBe('');
    expect(text.get('sketch-variant-6')).toBe('A plain quote.');
  });

  it('lists the elements of a page that has no block', () => {
    const { tree, body } = parse('# T\n\nIntro.\n\n- one {#one}\n- two\n\n```ts\nx\n```\n');
    expect(flatten(body)).toEqual(elementsOf(tree));
    expect(flatten(body)).toEqual([{ id: 'one', text: 'one' }]);
  });

  it('gives a quote that opens with something other than a paragraph no text, as deriveElements does', () => {
    const { tree, body } = parse(page(block('description', '> - a list', '> - of two')));
    expect(flatten(body)).toEqual(elementsOf(tree));
    expect(flatten(body).find((e) => e.id === 'description-sketch-1')).toEqual({ id: 'description-sketch-1', text: '' });
  });
});

describe('determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds the same bytes twice from the same page', () => {
    const md = EVERYTHING;
    expect(serialize(bodyOf(md))).toBe(serialize(bodyOf(md)));
    expect(serialize(bodyOf(md)).endsWith('}\n')).toBe(true);
  });

  it('builds the same bytes on any day and asks for no random number', () => {
    const random = vi.spyOn(Math, 'random');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-02-02T00:00:00Z'));
    const first = serialize(bodyOf(EVERYTHING));
    vi.setSystemTime(new Date('2031-03-03T00:00:00Z'));
    expect(serialize(bodyOf(EVERYTHING))).toBe(first);
    expect(random).not.toHaveBeenCalled();
  });

  it('never reads the clock, the locale or a random number', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('./kb-record.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date|Math\.random|localeCompare|Intl\.|randomUUID|process\.env/);
  });

  it('does not change the tree it reads', () => {
    const { tree } = parseKb(EVERYTHING);
    const before = JSON.stringify(tree);
    buildBody(tree, EVERYTHING, { linkTarget: target });
    expect(JSON.stringify(tree)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

const DOCS = path.resolve(fileURLToPath(import.meta.url), '../../../../docs');

/** Every page under docs/, as its path below docs/ and the markdown after its frontmatter. */
function realPages(): { file: string; source: string }[] {
  return (fs.readdirSync(DOCS, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, source: stripFrontmatter(fs.readFileSync(path.join(DOCS, file), 'utf8')) }));
}

/** Every Inline that is markdown, with the kind of node it came from. */
function inlinesOf(body: Body): { where: string; inline: Inline }[] {
  const out: { where: string; inline: Inline }[] = [];
  const add = (where: string, inline: Inline): void => void out.push({ where, inline });
  const flow = (nodes: readonly BodyNode[]): void => {
    for (const n of nodes) {
      switch (n.type) {
        case 'paragraph':
        case 'heading':
          add(n.type, { text: n.text, md: n.md });
          break;
        case 'group':
          add('group heading', n.heading);
          flow(n.content);
          break;
        case 'list':
          for (const item of n.items) {
            add('item', item);
            flow(item.content);
          }
          break;
        case 'table':
          n.header.forEach((cell) => add('cell', cell));
          for (const row of n.rows) row.cells.forEach((cell) => add('cell', cell));
          break;
        case 'sketch':
          if (n.form === 'prose' && n.summary !== null) add('summary', n.summary);
          flow(n.content);
          break;
        case 'quote':
          flow(n.content);
          break;
        default:
          break;
      }
    }
  };
  flow(body.intro);
  for (const b of body.blocks) {
    add('block heading', b.heading);
    flow(b.content);
  }
  return out;
}

const reader = unified().use(remarkParse).use(remarkGfm);

/** Markdown inline text read as the tail of a paragraph, as plain words, so a leading `1.` or `#` is no block. */
const wordsOf = (md: string): string => plainText(reader.parse(`x ${md}`).children[0] as Nodes).slice(1).trim();

interface Built {
  readonly file: string;
  readonly source: string;
  readonly tree: Root;
  readonly body: Body;
}

let built: Built[] | undefined;

/** Every page of the tree, parsed and built once however many tests read it. */
function realTree(): Built[] {
  built ??= realPages().map(({ file, source }) => {
    const { tree } = parseKb(source);
    return { file, source, tree, body: buildBody(tree, source, { linkTarget: target }) };
  });
  return built;
}

/** Every markdown link the page's own tree holds outside its marked regions and its title, in document order. */
function linksOutsideRegions(source: string): string[] {
  const doc = parsePage(source);
  const title = doc.h1 === null ? undefined : doc.tree.children.find((n) => n.type === 'heading' && n.depth === 1);
  return doc.tree.children.filter((n) => n !== title && !doc.regionOf.has(n)).flatMap((n) => linksIn(n));
}

// ---------------------------------------------------------------------------
// The HTML the site's markdown pipeline renders
// ---------------------------------------------------------------------------

/** A parse5 node, reduced to what the comparison reads. */
interface Dom {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly Dom[];
}

/**
 * The plugins Astro runs on a page's markdown, less the diagram renderer and
 * Starlight: the part that lays each id on its element and shapes each fence
 * and quote.
 */
const rendering = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkKbSite)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKbTables)
  .use(rehypeStringify, { allowDangerousHtml: true });

/** A page's body rendered without its title, as the mirror writes it, then cut into sections by the post-build pass. */
function rendered(source: string, file: string): Dom {
  const errors: PageError[] = [];
  const html = String(rendering.processSync(source.replace(/^# .*\n/m, '')));
  const sectioned = sectionMeta(`<div data-kb-region="">${html}</div>`, file, errors);
  expect(errors, file).toEqual([]);
  return parseFragment(sectioned) as unknown as Dom;
}

const attrOf = (el: Dom, name: string): string | undefined => el.attrs?.find((a) => a.name === name)?.value;
const elementsIn = (el: Dom): Dom[] => (el.childNodes ?? []).filter((c) => c.tagName !== undefined);
const descendants = (el: Dom): Dom[] => elementsIn(el).flatMap((c) => [c, ...descendants(c)]);
const idsUnder = (el: Dom): string[] => descendants(el).flatMap((d) => attrOf(d, 'id') ?? []);
const rawText = (n: Dom): string => (n.nodeName === '#text' ? (n.value as string) : (n.childNodes ?? []).map(rawText).join(''));

/** An element's words as HTML shows them: runs of ASCII whitespace one space, a no-break space kept. */
const shown = (n: Dom): string => rawText(n).replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');

const BLOCK_TAGS: ReadonlySet<string> = new Set(['ul', 'ol', 'details', 'div', 'figure', 'table', 'p', 'pre', 'blockquote', 'section', 'hr']);

/** A list item's own words: its first paragraph when it opens with one, else what comes before its first block. */
function ownWords(li: Dom): string {
  const first = (li.childNodes ?? []).find((c) => c.tagName !== undefined || rawText(c).trim() !== '');
  if (first?.tagName === 'p') return shown(first);
  const before: Dom[] = [];
  for (const c of li.childNodes ?? []) {
    if (c.tagName !== undefined && BLOCK_TAGS.has(c.tagName)) break;
    before.push(c);
  }
  return shown({ nodeName: 'li', childNodes: before });
}

/**
 * Hold a body to the DOM the site makes of the same page: every node with an id
 * is the element it should be, with the words it should show, and the blocks
 * and groups are the sections the post-build pass cuts, each holding the same
 * ids in the same order. Returns how many elements it compared.
 */
function agree(body: Body, dom: Dom, file: string): number {
  const all = descendants(dom);
  const byId = new Map(all.flatMap((d) => (attrOf(d, 'id') === undefined ? [] : [[attrOf(d, 'id') as string, d] as const])));
  let compared = 0;
  const element = (id: string | null, tag: string, what: string): Dom | undefined => {
    if (id === null) return undefined;
    compared += 1;
    const el = byId.get(id);
    expect(el?.tagName, `${file}#${id} is the ${what}`).toBe(tag);
    return el;
  };
  const says = (el: Dom | undefined, words: string, id: string | null): void => {
    if (el !== undefined) expect(shown(el), `${file}#${String(id)} shows`).toBe(words);
  };
  const part = (el: Dom | undefined, tag: string): Dom | undefined => (el === undefined ? undefined : elementsIn(el).find((c) => c.tagName === tag));
  /** A fence's source and language as the `<pre><code class="language-…">` the renderer draws it. */
  const fence = (el: Dom | undefined, node: { id: string | null; lang: string | null; code: string }): void => {
    const code = part(el === undefined ? undefined : descendants(el).find((d) => d.tagName === 'pre'), 'code');
    if (el === undefined) return;
    expect(code === undefined ? null : rawText(code).replace(/\n$/, ''), `${file}#${String(node.id)} code`).toBe(node.code);
    expect(code === undefined ? null : (attrOf(code, 'class') ?? null), `${file}#${String(node.id)} language`).toBe(
      node.lang === null ? null : `language-${node.lang}`,
    );
  };
  const visit = (node: BodyNode): void => {
    switch (node.type) {
      case 'paragraph':
        says(element(node.id, 'p', 'paragraph'), node.text, node.id);
        return;
      case 'heading':
        says(element(node.id, `h${String(node.depth)}`, 'heading'), node.text, node.id);
        return;
      case 'group':
        says(element(node.heading.id, 'h3', 'group heading'), node.heading.text, node.heading.id);
        node.content.forEach(visit);
        return;
      case 'list':
        element(node.id, node.ordered ? 'ol' : 'ul', 'list');
        for (const item of node.items) {
          const li = element(item.id, 'li', 'item');
          if (li !== undefined) {
            expect(ownWords(li), `${file}#${String(item.id)} shows`).toBe(item.text);
            const box = descendants(li).find((d) => d.tagName === 'input');
            expect(box === undefined ? null : attrOf(box, 'checked') !== undefined, `${file}#${String(item.id)} is checked`).toBe(item.checked);
          }
          item.content.forEach(visit);
        }
        return;
      case 'table':
        element(node.id, 'table', 'table');
        for (const row of node.rows) {
          const tr = element(row.id, 'tr', 'row');
          if (tr !== undefined) {
            expect(elementsIn(tr).map(shown).join(' | '), `${file}#${String(row.id)} shows`).toBe(row.cells.map((c) => c.text).join(' | '));
          }
        }
        return;
      case 'figure': {
        const el = element(node.id, node.lang === 'mermaid' ? 'div' : 'figure', 'figure');
        const caption = part(el, 'figcaption');
        if (el !== undefined) expect(caption === undefined ? null : shown(caption), `${file}#${String(node.id)} caption`).toBe(node.caption?.text ?? null);
        if (el !== undefined && node.lang === 'mermaid') expect(attrOf(el, 'data-kb-wide') !== undefined, `${file}#${String(node.id)} wide`).toBe(node.wide);
        fence(el, node);
        return;
      }
      case 'sketch': {
        const el = element(node.id, 'details', 'sketch');
        const summary = part(el, 'summary');
        if (el !== undefined) expect(summary === undefined ? null : shown(summary), `${file}#${String(node.id)} summary`).toBe(node.summary?.text ?? null);
        if (node.code !== null) fence(el, { id: node.id, lang: node.lang, code: node.code });
        node.content.forEach(visit);
        return;
      }
      case 'code':
        fence(element(node.id, 'div', 'code'), node);
        return;
      case 'quote':
        element(node.id, 'details', 'quote');
        node.content.forEach(visit);
        return;
      case 'html':
        return;
    }
  };
  body.intro.forEach(visit);
  for (const b of body.blocks) {
    says(element(b.id, 'h2', 'block heading'), b.heading.text, b.id);
    b.content.forEach(visit);
  }

  // Ids both ways: no element carries an id the record does not hold. Nothing here slugs a heading, so every id was written or
  // issued, except the `<a id>` a reference page writes as raw html for its links to land on, which no dialect element is.
  const carried = [...byId].flatMap(([id, el]) => (el.tagName === 'a' ? [] : [id]));
  expect(carried.sort(), `${file}: the ids of the elements`).toEqual(Object.keys(body.anchors).sort());

  const sections = all.filter((d) => d.tagName === 'section');
  const ids = (nodes: readonly BodyNode[]): string[] => flatten({ intro: nodes, blocks: [] }).map((e) => e.id);
  expect(
    sections.filter((s) => attrOf(s, 'data-block') !== undefined).map((s) => [attrOf(s, 'data-block'), idsUnder(s)]),
    `${file}: the block sections`,
  ).toEqual(body.blocks.map((b) => [b.name, [b.id, ...ids(b.content)]]));
  const groups = [...body.intro, ...body.blocks.flatMap((b) => b.content)].filter((n) => n.type === 'group');
  expect(
    sections.filter((s) => attrOf(s, 'data-block') === undefined).map((s) => [attrOf(s, 'data-polarity') ?? attrOf(s, 'data-requirement'), idsUnder(s)]),
    `${file}: the group sections`,
  ).toEqual(groups.map((g) => [g.value, ids([g])]));
  return compared;
}

describe('the HTML the site renders from a page', () => {
  it('has the elements, the words, the blocks and the groups of a page that has one of everything', () => {
    const { body } = parse(EVERYTHING);
    expect(agree(body, rendered(EVERYTHING, 'everything'), 'everything')).toBeGreaterThan(30);
  });

  it('shows a task item as checked or not, and a list item the words its first paragraph holds', () => {
    const md = page(block('description', '- [ ] open', '- [x] done', '', '3. third', '', '- first\\', '  second', '', '  Later.'));
    const { body } = parse(md);
    expect(agree(body, rendered(md, 'tasks'), 'tasks')).toBeGreaterThan(5);
    const list = as(only(md).content[0], 'list');
    expect(list.items.map((i) => i.checked)).toEqual([false, true]);
  });
});

describe('every page under docs/', () => {
  it(
    'lists the same ids, in the same order, with the same texts as deriveElements',
    () => {
      const pages = realTree();
      expect(pages.length).toBeGreaterThan(400);
      let ids = 0;
      for (const { file, tree, body } of pages) {
        const flat = flatten(body);
        expect(flat, file).toEqual(elementsOf(tree));
        expect(Object.keys(body.anchors), file).toEqual(flat.map((e) => e.id));
        for (const e of flat) expect(resolve(body, body.anchors[e.id] as string), `${file}#${e.id}`).toMatchObject({ id: e.id });
        ids += flat.length;
      }
      expect(ids).toBeGreaterThan(20_000);
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'builds the same bytes twice, and gives fp to exactly the nodes that have an id',
    () => {
      for (const { file, tree, source, body } of realTree()) {
        const once = serialize(body);
        expect(serialize(buildBody(tree, source, { linkTarget: target })), file).toBe(once);
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) value.forEach(walk);
          else if (typeof value === 'object' && value !== null) {
            const o = value as Record<string, unknown>;
            if ('fp' in o) expect(o['fp'] === null, `${file}: ${String(o['id'])}`).toBe(o['id'] === null);
            Object.values(o).forEach(walk);
          }
        };
        walk(JSON.parse(once));
      }
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'notes every link outside a marked region, in document order, and none inside one',
    () => {
      let links = 0;
      for (const { file, source, body } of realTree()) {
        expect(
          body.links.map((l) => l.href),
          file,
        ).toEqual(linksOutsideRegions(source));
        links += body.links.length;
      }
      expect(links).toBeGreaterThan(5_000);
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'keeps in md exactly the markup whose words text holds',
    () => {
      let inlines = 0;
      for (const { file, body } of realTree()) {
        for (const { where, inline } of inlinesOf(body)) {
          // A table cell escapes a pipe that a code span inside it holds; read alone, the span would keep the backslash.
          if (where === 'cell' && /\\\|/.test(inline.md)) continue;
          expect(wordsOf(inline.md), `${file}: ${where} ${inline.md}`).toBe(inline.text);
          inlines += 1;
        }
      }
      expect(inlines).toBeGreaterThan(30_000);
    },
    REAL_TREE_TIMEOUT,
  );

  it(
    'stands for the elements, the words, the blocks and the groups of the HTML the site renders',
    () => {
      let compared = 0;
      for (const { file, source, body } of realTree()) compared += agree(body, rendered(source, file), file);
      expect(compared).toBeGreaterThan(20_000);
    },
    REAL_TREE_TIMEOUT,
  );

  it('holds the one block written partly by hand and partly by a generator', () => {
    const page = realTree().find((p) => p.file === 'themes/system-design-interview.md') as Built;
    const tour = page.body.blocks.find((b) => b.name === 'tour') as Block;
    expect(tour.generated).toBe('tour');
    expect(tour.content[0]?.type).toBe('figure');
    expect(page.body.anchors['tour-fig-1']).toMatch(/^\/blocks\/\d+\/content\/0$/);
  });
});
