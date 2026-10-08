/**
 * The argument rules of scripts/kb.mjs — three boolean flags (two of them
 * every command's), every other flag takes a value, a positional is neither —
 * and the refusals that stop a typo being read as something else once the
 * command's flags are known.
 */

import { describe, expect, it } from 'vitest';

import { BOOL_FLAGS, parseArgs } from './args.js';
import { KbError, KbUsageError } from './corpus.js';

/** The message of the refusal `argv` meets under `accepted`, which must be a KbUsageError. */
function refusal(argv: string[], accepted: string[] = ['tag', 'band', 'kind', 'n']): string {
  try {
    parseArgs(argv, accepted);
  } catch (e) {
    expect(e).toBeInstanceOf(KbUsageError);
    expect(e).toBeInstanceOf(KbError);
    const message = (e as Error).message;
    expect(message, 'one line').not.toContain('\n');
    return message;
  }
  throw new Error(`expected a refusal of: ${argv.join(' ')}`);
}

describe('parseArgs read leniently, with no flags named', () => {
  it('reads positionals around flags and their values', () => {
    const a = parseArgs(['get', 'circuit-breaker', '--block', 'usage', '--json', 'extra']);
    expect(a.positional).toEqual(['get', 'circuit-breaker', 'extra']);
    expect(a.opt('block')).toBe('usage');
    expect(a.flag('json')).toBe(true);
    expect(a.flag('diagrams')).toBe(false);
    expect(a.argv).toHaveLength(6);
  });

  it('never takes the word after a boolean flag as its value', () => {
    const a = parseArgs(['--diagrams', 'get', 'x']);
    expect(a.positional).toEqual(['get', 'x']);
    expect([...BOOL_FLAGS]).toEqual(['json', 'diagrams', 'all']);
    const all = parseArgs(['record', '--all', 'breaker']);
    expect(all.positional).toEqual(['record', 'breaker']);
    expect(all.flag('all')).toBe(true);
    expect(all.opt('all')).toBeNull();
  });

  it('answers null for a flag that is absent or given last with no value', () => {
    const a = parseArgs(['find', 'cache', '--tag']);
    expect(a.opt('tag')).toBeNull();
    expect(a.opt('band')).toBeNull();
    expect(a.positional).toEqual(['find', 'cache']);
  });

  it('never throws: an unknown flag, a flag followed by a flag and a single-dash word are all read', () => {
    const a = parseArgs(['find', '-n', '3', '--jsno', '--tag', '--band', 'x']);
    expect(a.positional).toEqual(['find', '-n', '3']);
    expect(a.flag('jsno')).toBe(true);
    expect(a.opt('tag')).toBeNull();
    expect(a.opt('band')).toBe('x');
    expect(a.flag('anything')).toBe(false);
  });
});

describe('parseArgs read strictly, with the command’s flags named', () => {
  const accepted = ['tag', 'band', 'kind', 'n'];

  it('takes every flag the command names, the two global ones always, and every positional', () => {
    const a = parseArgs(['find', 'one', 'slow', '--tag', 'caching', '--n', '3', '--band', 'distributed', '--kind', 'pattern', '--json', '--diagrams'], accepted);
    expect(a.positional).toEqual(['find', 'one', 'slow']);
    expect(a.opt('tag')).toBe('caching');
    expect(a.opt('n')).toBe('3');
    expect(a.opt('band')).toBe('distributed');
    expect(a.opt('kind')).toBe('pattern');
    expect(a.flag('json')).toBe(true);
    expect(a.flag('diagrams')).toBe(true);
    // The globals need no naming, and a command with no flags of its own still takes them.
    expect(parseArgs(['get', 'x', '--json', '--diagrams'], []).flag('json')).toBe(true);
    expect(parseArgs(['get', 'x'], accepted).flag('json')).toBe(false);
  });

  it('takes a boolean flag that is not global only where the command names it, and never as a flag with a value', () => {
    const named = ['block', 'all'];
    const a = parseArgs(['record', '--all', 'breaker', '--block', 'usage'], named);
    expect(a.flag('all')).toBe(true);
    expect(a.opt('block')).toBe('usage');
    expect(a.positional).toEqual(['record', 'breaker']);
    expect(parseArgs(['record', 'breaker'], named).flag('all')).toBe(false);
    // `find` does not name it: a typo for another command's flag is refused, not read as nothing.
    expect(refusal(['find', 'x', '--all'])).toBe('unknown flag --all. This command takes --tag, --band, --kind, --n, --json, --diagrams');
    expect(() => parseArgs(['find', 'x'], ['tag']).flag('all')).toThrow('kb.mjs reads --all, which tools/src/kb/spec.ts does not declare for this command');
  });

  it('takes the flags in any order around the positionals, named by an array or a set', () => {
    const a = parseArgs(['--tag', 'x', 'find', 'query', '--json'], new Set(accepted));
    expect(a.positional).toEqual(['find', 'query']);
    expect(a.opt('tag')).toBe('x');
  });

  it('keeps the first of a flag given twice', () => {
    expect(parseArgs(['find', '--tag', 'a', '--tag', 'b'], accepted).opt('tag')).toBe('a');
  });

  it('answers null for a boolean flag read as a value, and for a value flag not given', () => {
    const a = parseArgs(['find', 'x', '--json'], accepted);
    expect(a.opt('json')).toBeNull();
    expect(a.opt('tag')).toBeNull();
    expect(a.flag('tag')).toBe(false);
    expect(parseArgs(['find', '--tag', 'a'], accepted).flag('tag')).toBe(true);
  });

  it('takes a value that begins with a dash, or with two dashes and a space', () => {
    const a = parseArgs(['link', 'a', 'b', '--note', '-x is wrong', '--n', '-1', '--tag', '--force is a flag in prose'], accepted.concat('note'));
    expect(a.opt('note')).toBe('-x is wrong');
    expect(a.opt('n')).toBe('-1');
    expect(a.opt('tag')).toBe('--force is a flag in prose');
    // A single-dash word that is not a letter after the dash is a positional: a negative number, a dash.
    expect(parseArgs(['find', '-1', '-', '—', '- item'], accepted).positional).toEqual(['find', '-1', '-', '—', '- item']);
  });

  it('refuses an unknown flag, naming it and every flag the command takes', () => {
    expect(refusal(['find', '--jsno', 'x'])).toBe('unknown flag --jsno. This command takes --tag, --band, --kind, --n, --json, --diagrams');
    expect(refusal(['get', 'x', '--block', 'usage'], [])).toBe('unknown flag --block. This command takes --json, --diagrams');
    expect(refusal(['find', '--'])).toBe('unknown flag --. This command takes --tag, --band, --kind, --n, --json, --diagrams');
  });

  it('refuses an unknown flag even where a value flag would take it, and one of another command', () => {
    expect(refusal(['find', '--tag', 'a', '--theme', 'b'])).toContain('unknown flag --theme');
    expect(refusal(['find', '--level', 'basic'])).toContain('unknown flag --level');
  });

  it('says a value goes in the next argument when the flag is written with an =', () => {
    expect(refusal(['find', '--n=3'])).toBe(
      'unknown flag --n=3 (a flag takes its value as the next argument, not after an =). This command takes --tag, --band, --kind, --n, --json, --diagrams',
    );
    expect(refusal(['find', '--json=true'])).toContain('not after an =');
  });

  it('refuses a value flag given last', () => {
    expect(refusal(['find', 'x', '--tag'])).toBe('--tag needs a value');
    expect(refusal(['find', 'x', '--n'])).toBe('--n needs a value');
  });

  it('refuses a value flag followed by another flag, boolean or not', () => {
    expect(refusal(['find', '--tag', '--band', 'x'])).toBe('--tag needs a value');
    expect(refusal(['get', 'x', '--n', '--json'])).toBe('--n needs a value');
  });

  it('refuses a single-dash word that looks like a flag, and suggests the two-dash one', () => {
    expect(refusal(['find', 'q', '-n', '3'])).toBe('-n is not a flag: flags start with two dashes, so write --n');
    expect(refusal(['find', '-block'])).toBe('-block is not a flag: flags start with two dashes, so write --block');
    expect(refusal(['find', '-J'])).toBe('-J is not a flag: flags start with two dashes, so write --J');
  });

  it('reports the first problem it meets, left to right', () => {
    expect(refusal(['find', '-n', '--jsno'])).toContain('-n is not a flag');
    expect(refusal(['find', '--jsno', '-n'])).toContain('unknown flag --jsno');
    expect(refusal(['find', '--tag', '--jsno'])).toBe('--tag needs a value');
  });

  it('throws a plain error, not a usage error, when the code reads a flag the command was not given', () => {
    const a = parseArgs(['find', 'x'], accepted);
    for (const read of [() => a.opt('theme'), () => a.flag('theme')]) {
      expect(read).toThrow('kb.mjs reads --theme, which tools/src/kb/spec.ts does not declare for this command');
      expect(read).not.toThrow(KbError);
    }
    // The global flags are always declared.
    expect(() => a.flag('diagrams')).not.toThrow();
    expect(() => a.opt('json')).not.toThrow();
  });
});
