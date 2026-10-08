/**
 * The argument rules of scripts/kb.mjs, and the refusals that stop a typo being
 * read as something else:
 *
 *   --json, --diagrams     boolean flags, taken by every command
 *   --all                  a boolean flag, taken by the commands that list it
 *   --<name> <value>       every other flag takes the next argument as its value
 *   a positional           any argument that is not a flag and not a flag's value
 *
 * A flag is `--` and a name as one shell word, so a value that is a sentence
 * beginning with `--` stays a value.
 *
 * Told which flags the command takes, `parseArgs` is strict and throws a
 * KbUsageError, which `run` turns into exit 2, for what would otherwise be
 * dropped without a word: an unknown `--flag` (a typo, or a flag the command
 * has not), a value flag with no value (given last, or followed by another
 * flag) and a single-dash word that looks like a flag, since `-n 3` is not
 * `--n 3`. A strict `Args` also throws a plain Error when the code reads a flag
 * it was not told of, so a flag spec.ts forgot fails the first test that runs
 * the command instead of passing for ever as "absent".
 *
 * Told nothing, it reads leniently and never throws: a value flag given last
 * answers null. `run` reads that way once, to find the command, and again
 * strictly with the command's own flags (tools/src/kb/spec.ts `flagsOf`).
 */

import { KbUsageError } from './corpus.js';

/** The flags that take no value: the next word is never theirs. */
export const BOOL_FLAGS: ReadonlySet<string> = new Set(['json', 'diagrams', 'all']);

/** The boolean flags every command takes; another boolean flag is taken only where the command names it. */
const GLOBAL_FLAGS: readonly string[] = ['json', 'diagrams'];

export interface Args {
  readonly argv: readonly string[];
  readonly positional: readonly string[];
  flag(name: string): boolean;
  opt(name: string): string | null;
}

/** A flag word: `--` and a name, as one shell word. */
const isFlag = (a: string): boolean => a.startsWith('--') && !/\s/.test(a);

/** A word that looks like a flag written with one dash. */
const SINGLE_DASH = /^-[A-Za-z]/;

/** The one-line refusal of a flag the command does not take, with what it does take. */
function unknownFlag(token: string, known: ReadonlySet<string>): string {
  const equals = token.includes('=') ? ' (a flag takes its value as the next argument, not after an =)' : '';
  return `unknown flag ${token}${equals}. This command takes ${[...known].map((n) => `--${n}`).join(', ')}`;
}

/**
 * The arguments of one run. `accepted` names the flags the command takes,
 * without their dashes; `json` and `diagrams` are always taken. Omit it to
 * read leniently.
 */
export function parseArgs(argv: readonly string[], accepted?: readonly string[] | ReadonlySet<string>): Args {
  const known = accepted === undefined ? undefined : new Set([...accepted, ...GLOBAL_FLAGS]);
  const positional: string[] = [];
  const given = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!isFlag(a)) {
      if (known !== undefined && SINGLE_DASH.test(a)) throw new KbUsageError(`${a} is not a flag: flags start with two dashes, so write --${a.slice(1)}`);
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (known !== undefined && !known.has(name)) throw new KbUsageError(unknownFlag(a, known));
    given.add(name);
    if (BOOL_FLAGS.has(name)) continue;
    const next = argv[i + 1];
    if (next === undefined || isFlag(next)) {
      if (known !== undefined) throw new KbUsageError(`${a} needs a value`);
      continue;
    }
    // The first of a repeated flag wins.
    if (!values.has(name)) values.set(name, next);
    i += 1;
  }
  const read = (name: string): void => {
    if (known !== undefined && !known.has(name)) throw new Error(`kb.mjs reads --${name}, which tools/src/kb/spec.ts does not declare for this command`);
  };
  return {
    argv,
    positional,
    flag: (name) => {
      read(name);
      return given.has(name);
    },
    opt: (name) => {
      read(name);
      return values.get(name) ?? null;
    },
  };
}
