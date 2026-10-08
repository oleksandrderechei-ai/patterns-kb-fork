/**
 * The kb.mjs command surface, as data. The usage text prints from here, so
 * the surface is written down once, and so does the argument parser: a flag
 * a command reads but this list leaves out is refused as unknown. `RETIRED`
 * names the commands that are gone and what replaced them.
 *
 *   name   the subcommand
 *   args   the positional signature
 *   group  "read" (never writes) or "write" (edits a page through a writer)
 *   desc   one sentence
 *   flags  [{ flag, desc? }], each `--name` first, then what it takes
 *   note   the caveat that stops someone using it wrongly
 */

export interface CliFlag {
  readonly flag: string;
  readonly desc?: string;
}

export interface CliCommand {
  readonly name: string;
  readonly args: string;
  readonly group: 'read' | 'write';
  readonly desc: string;
  readonly flags: readonly CliFlag[];
  readonly note?: string;
}

export const CLI_COMMANDS: readonly CliCommand[] = [
  {
    name: 'find', args: '<query…>', group: 'read',
    desc: 'Search names, essences, aliases, tags and symptoms. The way in from a symptom you can describe but cannot name.',
    flags: [{ flag: '--tag <t>' }, { flag: '--band <b>' }, { flag: '--kind <k>' }, { flag: '--n <8>', desc: 'the most matches to print, a whole number of 1 or more' }],
  },
  {
    name: 'get', args: '<id>', group: 'read',
    desc: 'One page, cleaned of markup and navigation — or one block of it.',
    flags: [
      { flag: '--block <b>', desc: 'just that block, about 180 tokens instead of ~4k' },
      { flag: '--diagrams', desc: 'keep the mermaid source, omitted by default as noise' },
    ],
    note: 'On the `wild` and `production` blocks, `--json` also dumps `items` in the writers\' own shape — edit one entry and hand the lot back, rather than re-typing the neighbours from rendered prose and dropping their inline `<code>`. On `explain`, `--json` dumps `{text, example}`, plus `costs` when the block has a costs list and `exampleLang` and `exampleCaption` when the example is a sketch; a link in the text or a cost note comes back as `[term](path.md)`.',
  },
  {
    name: 'brief', args: '<query…>', group: 'read',
    desc: 'One-call scout bundle: the find hits, the governing theme\'s decide table, and the typed neighbours of the top hits.',
    flags: [{ flag: '--theme <id>' }, { flag: '--tag <t>' }, { flag: '--band <b>' }, { flag: '--kind <k>' }, { flag: '--n <5>', desc: 'the most matches to print, a whole number of 1 or more' }],
    note: 'Replaces the three to six calls an agent otherwise spends putting exactly this sequence together.',
  },
  {
    name: 'related', args: '<id>', group: 'read',
    desc: 'The typed neighbours — what it combines with, what replaces it, what it gets confused for.',
    flags: [],
  },
  {
    name: 'backlinks', args: '<id>', group: 'read',
    desc: 'What points here: typed inbound edges plus the prose mentions that never became edges.',
    flags: [],
  },
  {
    name: 'refs', args: '[<id>]', group: 'read',
    desc: 'What this page points AT: relations, prose links, theme members, mermaid clicks.',
    flags: [{ flag: '--file <path>' }],
    note: 'Read from the page and the data files as they stand, so an edit that changed what a page uses can be reconciled before anything is rebuilt.',
  },
  {
    name: 'ls', args: '', group: 'read',
    desc: 'List pages, filtered.',
    flags: [{ flag: '--band <b>' }, { flag: '--kind <k>' }],
  },
  {
    name: 'validate', args: '[<id>]', group: 'read',
    desc: 'Structural lint against the page shape. No argument validates every page.',
    flags: [{ flag: '--file <path>' }],
  },
  {
    name: 'record', args: '<id>', group: 'read',
    desc: 'One page as a record (kb-record/1): every block as typed nodes with element ids and fingerprints, the typed relations, the links and the anchors.',
    flags: [
      { flag: '--block <a,b>', desc: 'only these blocks, comma-separated; the record\'s `scope` lists the ones kept' },
      { flag: '--all', desc: 'every page, one compact record per line in `ls` order (JSON Lines), in place of one id' },
    ],
    note: 'Always JSON: --json is accepted and changes nothing. Cite an element as <id>#<element id>@<fp>, with the `fp` the record gives it, and check the citation later with `resolve`.',
  },
  {
    name: 'graph', args: '', group: 'read',
    desc: 'The whole link graph as one JSON document (kb-graph/1): every page, every typed edge with both sides\' notes, every tour and every prose mention.',
    flags: [],
    note: 'Always JSON: --json is accepted and changes nothing.',
  },
  {
    name: 'resolve', args: '<ref…>', group: 'read',
    desc: 'Check citations: is each <id>#<element>@<fp> still there, moved, changed or gone? Prints one line per ref, or a JSON array with --json.',
    flags: [],
    note: 'A ref is <id>#<element id>, with @<fp> to pin the words (a block, <id>#<block name>, takes no pin: its id is its name, so a pin on one is ignored); a docs/…/x.md path, a …/x.html path or a site URL ending in either stands for the id. Each is ok (there, and the words are the cited ones), moved (the words are on another id now), ambiguous, changed or gone. Exit 0 when every ref is ok, and 1 when any is not, with --json too; a ref with no # is exit 2.',
  },
  {
    name: 'set', args: '<id>', group: 'write',
    desc: 'Set the page\'s frontmatter. Each list flag takes JSON, so a value survives a comma inside a sentence.',
    flags: [
      { flag: '--aliases \'["CB"]\'' }, { flag: '--tags \'[…]\'' }, { flag: '--solves \'[…]\'' },
      { flag: '--essence "…"' },
      { flag: '--favourite true|false', desc: 'the editorial pick — a * chip and a hub filter' },
    ],
  },
  {
    name: 'wild', args: '<id>', group: 'write',
    desc: 'Replace the "In the wild" block — real, well-known implementations only.',
    flags: [{ flag: '--items \'[{"id":"envoy","name":"Envoy","note":"…"}]\'' }],
    note: 'Replaces the WHOLE block, so re-supply every item. Dump the current one with `get --block wild --json`, which returns exactly this shape. Text may carry `<code>` and all other markup is escaped.',
  },
  {
    name: 'production', args: '<id>', group: 'write',
    desc: 'Replace the production block: what it takes to run the pattern.',
    flags: [
      { flag: '--knobs \'[{"label":…,"note":…}]\'' }, { flag: '--signals \'[…]\'' },
      { flag: '--failures \'[…]\'' }, { flag: '--checklist \'["…"]\'' },
    ],
    note: 'Replaces the whole block, same as `wild`. Any list may be empty and its group is simply omitted.',
  },
  {
    name: 'explain', args: '<id>', group: 'write',
    desc: 'Write the explain block: one paragraph of expert-grade explanation in plain words, a costs list, then one short example.',
    flags: [
      { flag: '--text "…"', desc: 'the paragraph, 60 to 180 words, no bold label; write [term](path.md) to link a term on its first use' },
      { flag: '--costs \'[{"lead":"…","note":"…"}]\'', desc: '2 to 4 bullets of at most 25 words each, a bold lead and a note; a note may link a term as [term](path.md); required on a pattern; left out it keeps the page\'s own list, [] drops it' },
      { flag: '--example "…"', desc: 'the example paragraph, at most 120 words; the **Example.** label is added' },
      { flag: '--example-lang <lang>', desc: 'write the example as a fenced sketch in that language instead (at most 25 lines, newlines kept)' },
      { flag: '--example-caption "…"', desc: 'the question the sketch answers; required with --example-lang' },
    ],
    note: 'Replaces the whole block and refuses a shape KB-014 rejects. Both text and example empty removes the block. kb.mjs get <id> --block explain --json dumps the current text, costs and example.',
  },
  {
    name: 'link', args: '<from> <verb> <to>', group: 'write',
    desc: 'Declare a relationship. Writes the one edge record both pages render from, which is what keeps the graph bidirectional.',
    flags: [
      { flag: '--note "…"' },
      { flag: '--note-back "…"' },
      { flag: '--group "…"', desc: 'the heading this side sits under on its page, when it is not the verb\'s own' },
      { flag: '--group-back "…"', desc: 'the same for the other side' },
      { flag: '--maps <row-id>', desc: 'on an implements edge, the capability mapping row or comparison matrix row it pins (mapping-row-N, matrix-row-N); the row\'s label is written beside it, and the relations gate fails the pin once that row moves' },
    ],
    note: 'Each side may phrase its note its own way; only the edge and its verb must agree. Regrouping an edge is `unlink` then `link --group`.',
  },
  {
    name: 'unlink', args: '<a> <b>', group: 'write',
    desc: 'Drop the edge between two pages, whatever verb each side reads. Re-typing an edge is `unlink` then `link`.',
    flags: [],
  },
  {
    name: 'new', args: '<id>', group: 'write',
    desc: 'Scaffold a page with every block its kind requires, in order, and give it a row in the structure file.',
    flags: [
      { flag: '--kind <k>' }, { flag: '--band <b>' }, { flag: '--group <g>' },
      { flag: '--name "…"' }, { flag: '--order <n>' }, { flag: '--tags \'[…]\'' },
    ],
    note: '`--band` is a pattern\'s area under patterns; `--group` names the area the page sits in when the band or kind is split into several. `--order` is its place in that area, 1 first, the end when left out. The page is a draft until you say otherwise; a theme also gets its profile in learning-paths.json.',
  },
];

/** The commands v1 had and v2 does not, with what to do instead. */
export const RETIRED: Readonly<Record<string, string>> = {
  register: 'register is retired: a page reads at one depth, so there is no register to choose.',
  level: 'reading levels were retired: a page reads at one depth',
};

/** Flags that apply to every command rather than one. */
export const CLI_GLOBAL_FLAGS: readonly CliFlag[] = [
  { flag: '--json', desc: 'structured output instead of text' },
  { flag: '--diagrams', desc: 'keep the mermaid source, omitted by default as noise' },
];

/** The name a flag's usage string declares: `--tag <t>` and `--aliases '["CB"]'` are `tag` and `aliases`. */
export function flagName(flag: string): string {
  return (flag.split(' ')[0] as string).slice(2);
}

/**
 * The flag names a command takes, each once: its own, then the global ones. A
 * word that is no command takes only the global ones. This is what the
 * argument parser is handed to refuse every other flag.
 */
export function flagsOf(command: string): string[] {
  const own = CLI_COMMANDS.find((c) => c.name === command)?.flags ?? [];
  return [...new Set([...own, ...CLI_GLOBAL_FLAGS].map((f) => flagName(f.flag)))];
}

export const USAGE_HEADER = `kb.mjs — read the knowledge base without reading the pages whole.

The whole corpus is millions of tokens, far more than fits in a context window. This is the way in:
it reads the markdown under docs/ and the data files beside it, and returns the facts and the
prose, block by block.`;

/**
 * What each exit code of a run means, printed at the end of the usage. 1 is a
 * call that is well formed and that the knowledge base refuses, so the content
 * is what to fix; 2 is a call that is malformed, so the command is.
 */
export const EXIT_CODES = `Exit codes:
  0  done, including a search that found nothing
  1  a well-formed call the knowledge base refuses (fix the content): an unknown id or block, a check that found problems, a writer that refused
  2  a malformed call (fix the command): an unknown command or flag, a flag with no value, a missing id, query or required flag, a value of the wrong form`;

/**
 * A command's signature as the usage prints it, `kb.mjs find <query…> [--tag <t>] …`,
 * and as a usage error repeats it: the one function builds both, so a flag added
 * to the list is in both. `name` must be a command of CLI_COMMANDS.
 */
export function usageLine(name: string): string {
  const c = CLI_COMMANDS.find((x) => x.name === name) as CliCommand;
  return `kb.mjs ${c.name}${c.args === '' ? '' : ` ${c.args}`}${c.flags.map((f) => ` [${f.flag}]`).join('')}`;
}

/** The usage text: every command, read ones first. */
export function usageText(header = ''): string {
  const out = header === '' ? [] : [header, ''];
  for (const group of ['read', 'write'] as const) {
    out.push(group === 'read' ? 'Reading:' : '\nWriting (authoring goes through here, so the data stays well-formed):');
    for (const c of CLI_COMMANDS.filter((x) => x.group === group)) {
      out.push(`  ${usageLine(c.name)}`);
      out.push(`      ${c.desc}`);
      for (const f of c.flags) if (f.desc !== undefined) out.push(`      ${f.flag}  ${f.desc}`);
      if (c.note !== undefined) out.push(`      ${c.note}`);
    }
  }
  out.push('');
  for (const f of CLI_GLOBAL_FLAGS) out.push(`  ${f.flag}${' '.repeat(Math.max(1, 12 - f.flag.length))}${f.desc as string}`);
  out.push('', EXIT_CODES);
  return out.join('\n');
}
