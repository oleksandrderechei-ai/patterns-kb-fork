/**
 * The kb.mjs command surface: every command once, `register` retired, the
 * usage printed from the one list, and the flag names the argument parser is
 * handed read out of it.
 */

import { describe, expect, it } from 'vitest';

import { CLI_COMMANDS, CLI_GLOBAL_FLAGS, EXIT_CODES, flagName, flagsOf, RETIRED, USAGE_HEADER, usageLine, usageText } from './spec.js';

describe('the command surface', () => {
  it('carries each command once, in reading-then-writing order, and retires register and level', () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['find', 'get', 'brief', 'related', 'backlinks', 'refs', 'ls', 'validate', 'record', 'graph', 'resolve', 'set', 'wild', 'production', 'explain', 'link', 'unlink', 'new']);
    expect(CLI_COMMANDS.find((c) => c.name === 'link')?.flags.map((f) => f.flag)).toEqual(expect.arrayContaining(['--group "…"', '--group-back "…"']));
    expect(Object.keys(RETIRED)).toEqual(['register', 'level']);
    expect(CLI_GLOBAL_FLAGS.map((f) => f.flag)).toEqual(['--json', '--diagrams']);
  });

  it('prints the usage: reading first, then writing, then the global flags, then the exit codes', () => {
    const text = usageText(USAGE_HEADER);
    expect(text.startsWith(USAGE_HEADER)).toBe(true);
    expect(text.indexOf('Reading:')).toBeLessThan(text.indexOf('Writing'));
    expect(text).toContain('  kb.mjs ls [--band <b>] [--kind <k>]');
    expect(text).toContain('      --block <b>  just that block');
    expect(text).toContain('\n  --json      structured output instead of text');
    expect(text.indexOf('--diagrams')).toBeLessThan(text.indexOf('Exit codes:'));
    expect(text.endsWith(EXIT_CODES)).toBe(true);
    expect(text).not.toContain('register');
  });

  it('says what each exit code means: 0 done, 1 a well-formed call the KB refuses, 2 a malformed call', () => {
    expect(EXIT_CODES.split('\n').map((l) => l.trim().slice(0, 1))).toEqual(['E', '0', '1', '2']);
    expect(EXIT_CODES).toContain('1  a well-formed call the knowledge base refuses (fix the content): an unknown id or block, a check that found problems, a writer that refused');
    expect(EXIT_CODES).toContain('2  a malformed call (fix the command): an unknown command or flag, a flag with no value, a missing id, query or required flag, a value of the wrong form');
  });

  it('prints no header when none is given', () => {
    expect(usageText().startsWith('Reading:')).toBe(true);
  });

  it('says what the retrieval commands print: the records as JSON, one per line with --all, and the exit code of a citation check', () => {
    const text = usageText();
    expect(text).toContain('      --all  every page, one compact record per line in `ls` order (JSON Lines), in place of one id');
    expect(text).toContain('      --block <a,b>  only these blocks, comma-separated; the record\'s `scope` lists the ones kept');
    expect(text).toContain('Always JSON: --json is accepted and changes nothing.');
    expect(text).toContain('Exit 0 when every ref is ok, and 1 when any is not, with --json too; a ref with no # is exit 2.');
    // They read; none writes.
    for (const name of ['record', 'graph', 'resolve']) expect(CLI_COMMANDS.find((c) => c.name === name)?.group, name).toBe('read');
  });

  it('writes a command’s signature once, for the usage and for every usage error that repeats it', () => {
    expect(usageLine('find')).toBe('kb.mjs find <query…> [--tag <t>] [--band <b>] [--kind <k>] [--n <8>]');
    expect(usageLine('brief')).toBe('kb.mjs brief <query…> [--theme <id>] [--tag <t>] [--band <b>] [--kind <k>] [--n <5>]');
    expect(usageLine('link')).toBe('kb.mjs link <from> <verb> <to> [--note "…"] [--note-back "…"] [--group "…"] [--group-back "…"] [--maps <row-id>]');
    expect(usageLine('unlink')).toBe('kb.mjs unlink <a> <b>');
    // `ls` has no positional, so no extra space after its name; `related` has no flags, so no brackets.
    expect(usageLine('ls')).toBe('kb.mjs ls [--band <b>] [--kind <k>]');
    expect(usageLine('related')).toBe('kb.mjs related <id>');
    // The retrieval commands: a block list, a flag that takes no id, no flags at all, and one or more refs.
    expect(usageLine('record')).toBe('kb.mjs record <id> [--block <a,b>] [--all]');
    expect(usageLine('graph')).toBe('kb.mjs graph');
    expect(usageLine('resolve')).toBe('kb.mjs resolve <ref…>');
    // The usage holds the line of every command, so a flag added to a command is in both at once.
    const lines = usageText().split('\n');
    for (const c of CLI_COMMANDS) expect(lines, c.name).toContain(`  ${usageLine(c.name)}`);
  });
});

describe('the flag names', () => {
  it('reads a flag’s name from its usage string, whatever follows it', () => {
    expect(flagName('--tag <t>')).toBe('tag');
    expect(flagName('--aliases \'["CB"]\'')).toBe('aliases');
    expect(flagName('--favourite true|false')).toBe('favourite');
    expect(flagName('--example-lang <lang>')).toBe('example-lang');
    expect(flagName('--note "…"')).toBe('note');
    expect(flagName('--json')).toBe('json');
  });

  it('gives every flag of every command a plain lower-case name, once per command', () => {
    for (const c of CLI_COMMANDS) {
      const names = flagsOf(c.name);
      for (const n of names) expect(n, `${c.name} ${n}`).toMatch(/^[a-z][a-z-]*$/);
      expect(new Set(names).size, c.name).toBe(names.length);
    }
  });

  it('gives a command its own flags, then the global ones, and an unknown word the global ones alone', () => {
    expect(flagsOf('find')).toEqual(['tag', 'band', 'kind', 'n', 'json', 'diagrams']);
    expect(flagsOf('brief')).toEqual(['theme', 'tag', 'band', 'kind', 'n', 'json', 'diagrams']);
    // `get` names --diagrams itself and takes it as a global: it is listed once.
    expect(flagsOf('get')).toEqual(['block', 'diagrams', 'json']);
    expect(flagsOf('related')).toEqual(['json', 'diagrams']);
    expect(flagsOf('record')).toEqual(['block', 'all', 'json', 'diagrams']);
    expect(flagsOf('graph')).toEqual(['json', 'diagrams']);
    expect(flagsOf('resolve')).toEqual(['json', 'diagrams']);
    expect(flagsOf('set')).toEqual(['aliases', 'tags', 'solves', 'essence', 'favourite', 'json', 'diagrams']);
    expect(flagsOf('frobnicate')).toEqual(['json', 'diagrams']);
  });

  it('declares --n on find, which reads it, as it does on brief', () => {
    for (const name of ['find', 'brief']) {
      expect(CLI_COMMANDS.find((c) => c.name === name)?.flags.map((f) => f.flag), name).toContainEqual(expect.stringMatching(/^--n </));
    }
  });
});
