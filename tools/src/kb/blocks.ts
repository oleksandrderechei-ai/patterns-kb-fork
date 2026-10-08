/**
 * The three writer-owned blocks as markdown, in the dialect's shape
 * (tools/src/lib/dialect.md D-50, D-51, D-53): what `kb.mjs explain`,
 * `wild` and `production` put on a page. Each function returns the block's
 * lines, `##` heading and fact line first, with no blank line at either end;
 * tools/src/kb/edit.ts places them.
 *
 * The bytes are the converter's for the same content (inline.ts says why),
 * so a block rewritten with the items `kb.mjs get --json` dumped is the block
 * that was there.
 */

import { EXAMPLE_LABEL } from '../lib/explain-shape.js';
import { printFacts, printFenceInfo, printSuffix } from '../lib/kb-attrs.js';
import { guardTrailingBrace } from '../lib/md-text.js';

import { inlineMd, linkedTokens, plainTokens, richTokens, type Tok } from './inline.js';

/** `text` (never empty here) with its suffix, a space between. */
function withSuffix(text: string, suffix: string): string {
  return suffix === '' ? text : `${text} ${suffix}`;
}

/** A list item line: the marker, the text guarded against a trailing brace, the suffix. */
function item(md: string, suffix = ''): string {
  return `- ${withSuffix(guardTrailingBrace(md), suffix)}`.replace(/ +$/, '');
}

function head(heading: string, block: string): string[] {
  return [`## ${heading}`, printFacts({ block })];
}

/** What the explain block holds: the paragraph, and the example as prose or as a captioned sketch. */
export interface ExplainInput {
  /** The paragraph; a `[label](path.md)` in it is written as a link. */
  readonly text: string;
  /** The costs list: a bold lead and a note per bullet, written between the paragraph and the example. */
  readonly costs?: readonly CostInput[];
  /** The example's prose, or its code when `exampleLang` is given. */
  readonly example: string;
  /** With a language the example is a fenced sketch, which also needs a caption. */
  readonly exampleLang?: string;
  readonly exampleCaption?: string;
}

/** A fence long enough that no run of backticks in `code` closes it early. */
function fenceFor(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

/** One bullet of the costs list. */
export interface CostInput {
  /** The bold lead, plain text. */
  readonly lead: string;
  /** The words after the lead; a `[label](path.md)` in it is written as a link, as in the paragraph. */
  readonly note: string;
}

/**
 * The explain block: one paragraph, a costs list, then one example (D-50).
 * The paragraph and each cost note share one link rule (`linkedTokens`), so a
 * link written in either is a link on the page, and the dump hands both back
 * in the form they were written.
 */
export function explainLines(heading: string, input: ExplainInput): string[] {
  const out = head(heading, 'explain');
  out.push('', guardTrailingBrace(inlineMd(linkedTokens(input.text), true)));
  if (input.costs !== undefined && input.costs.length > 0) {
    out.push('');
    for (const c of input.costs) {
      out.push(`- ${inlineMd([{ k: 'strong', open: true }, { k: 'text', v: c.lead }, { k: 'strong', open: false }, ...linkedTokens(` ${c.note}`)])}`);
    }
  }
  if (input.exampleLang === undefined) {
    out.push('', guardTrailingBrace(`**${EXAMPLE_LABEL}** ${inlineMd(plainTokens(input.example), true)}`));
    return out;
  }
  const fence = fenceFor(input.example);
  const caption = input.exampleCaption === undefined ? {} : { caption: input.exampleCaption };
  out.push('', `${fence}${printFenceInfo(input.exampleLang, caption)}`, ...input.example.replace(/\n+$/, '').split('\n'), fence);
  return out;
}

export interface WildInput {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly href?: string;
}

/** The wild block: one item per example, each with its keyed id (D-53). Name and note are rich text. */
export function wildLines(heading: string, items: readonly WildInput[]): string[] {
  const out = [...head(heading, 'wild'), ''];
  for (const w of items) {
    const name = richTokens(w.name);
    const toks: Tok[] = w.href === undefined ? name : [{ k: 'link', open: true, dest: w.href }, ...name, { k: 'link', open: false, dest: w.href }];
    const note = inlineMd(richTokens(w.note), true);
    const md = `**${inlineMd(toks, true)}**${note === '' ? '' : ` — ${note}`}`;
    out.push(item(md, printSuffix({ id: `wild-${w.id}` })));
  }
  return out;
}

export interface LabelledInput {
  readonly label: string;
  readonly note: string;
}
export interface GateInput {
  readonly text: string;
}

/** One group of the production block, under its `###` and polarity fact. */
export interface ProductionGroup {
  readonly polarity: 'knob' | 'signal' | 'failure' | 'check';
  readonly heading: string;
  readonly items: readonly (LabelledInput | GateInput)[];
}

/**
 * The production block: a group per non-empty list, in the order given, each
 * item a bold label and its note, or a checklist gate's text (D-51). Rich text.
 */
export function productionLines(heading: string, groups: readonly ProductionGroup[]): string[] {
  const out = head(heading, 'production');
  for (const g of groups) {
    if (g.items.length === 0) continue;
    out.push('', `### ${g.heading}`, printFacts({ polarity: g.polarity }), '');
    for (const x of g.items) {
      const toks: Tok[] =
        'text' in x
          ? richTokens(x.text)
          : [{ k: 'strong', open: true }, ...richTokens(x.label), { k: 'strong', open: false }, { k: 'text', v: ' — ' }, ...richTokens(x.note)];
      out.push(item(inlineMd(toks, true)));
    }
  }
  return out;
}
