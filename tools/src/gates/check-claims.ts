/**
 * Hold the command claims in the markdown to the tree (spec:
 * kb.harness.truth-sweep, claim-gate).
 *
 * A passing page can still name a `make` target that was renamed, a gate that
 * was retired or a script that moved. Each is a claim, and a reader who runs
 * it gets an error at best. The claims rule asks the change that moves a thing
 * to fix every claim naming it; this gate is the floor under that rule for the
 * one kind of claim a machine can judge without running anything: a command in
 * a shell-labelled fence.
 *
 *   read      every line of a fence labelled bash, sh, shell, zsh, console
 *             or shell-session, in the top-level markdown files, the pages
 *             under docs/ and the harness files (every CLAUDE.md and all
 *             markdown under .claude/). A leading `$ ` prompt is dropped; in a
 *             console or shell-session fence only a prompted line is a
 *             command, the rest is output. A command prefix — an assignment,
 *             env, sudo, time, nohup, nice, exec, command, xargs, with their
 *             options — is read past, so the program it runs is judged.
 *   judged    `make <target>…`: each target is a rule in the Makefile, and a
 *             flag's value (`-j 4`, `-o file`) is not a target;
 *             `make gate G=<stem>`: the stem is a gate or generator under
 *             tools/src/gates or tools/src/gen; a program path, run by node,
 *             tsx, bash, sh, zsh or python or written as the command itself:
 *             on disk.
 *   skipped   a stamped file, a marked block, an unlabelled
 *             fence, an inline code span, a heredoc body, a line inside a quote
 *             left open by an earlier line, a word holding a placeholder
 *             (`<name>`, `…`, `*`, `$VAR`), everything after a `cd` on the same
 *             line, and a line whose comment says `claim-ok`. After the first
 *             word that is not a target — an assignment, a placeholder — no
 *             word of that `make` call is read as a target.
 *
 * A file is stamped when a line of its own, outside a fence, is a whole-file
 * stamp; the whole file is searched, so a stamp below frontmatter counts, and
 * a page quoting the stamp in prose or a sample is still read. A marked block
 * runs from a start marker on a line of its own to its end marker on a line
 * of its own; a start with no end is a finding, since everything after it
 * would otherwise go unread.
 *
 * What it cannot judge — a flag's meaning, a sentence in prose, a count — is
 * the claims rule's and review's (.claude/rules/claims.md).
 *
 * Usage: check-claims   (takes no arguments: a claim breaks when its target moves, anywhere)
 */

import fs from 'node:fs';
import path from 'node:path';

import { gitFiles } from '../lib/exec.js';
import { main, type GateContext, type GateSpec } from '../lib/gate.js';
import { isStamped } from '../lib/generated.js';

/** Fence labels whose lines are shell commands. */
export const SHELL_LABELS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shell-session']);
/** Labels whose fences mix commands and output: only a `$ ` line is a command. */
const PROMPTED = new Set(['console', 'shell-session']);
/** The comment that silences one line. */
export const OPT_OUT = 'claim-ok';
/** Where `make gate G=<stem>` looks, in the Makefile's own order. */
export const GATE_DIRS = ['tools/src/gates', 'tools/src/gen'];

/** Is this repo-relative file one whose command claims this gate reads? */
export function isClaimFile(file: string): boolean {
  if (!file.endsWith('.md')) return false;
  return (
    !file.includes('/') ||
    file.startsWith('docs/') ||
    file.startsWith('.claude/') ||
    path.posix.basename(file) === 'CLAUDE.md'
  );
}

/**
 * A file stamped whole by a generator: its claims are fixed through its
 * source. One reading of "stamped" for every tool (lib/generated.ts), so the
 * structure gate and this one never disagree about which files are output.
 */
export { isStamped };

/** Every target the Makefile defines, from its rule lines. */
export function makeTargets(makefile: string): Set<string> {
  const out = new Set<string>();
  for (const line of makefile.split('\n')) {
    if (line.startsWith('\t') || line.startsWith('#')) continue;
    const m = /^([^\s:#=][^:=]*?)\s*::?(?!=)/.exec(line);
    if (m === null) continue;
    for (const t of (m[1] as string).split(/\s+/)) {
      if (t !== '' && !t.startsWith('.') && !/[$%]/.test(t)) out.add(t);
    }
  }
  return out;
}

export interface CommandLine {
  /** 1-based line in the file, the first line of a continued command. */
  readonly line: number;
  /** The command text: prompt dropped, continuations joined. */
  readonly text: string;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const MARK_START = /^\s*<!--\s*([a-z]+(?:-[a-z]+)*):start\s*-->\s*$/;
const markEnd = (name: string): RegExp => new RegExp(`^\\s*<!--\\s*${name}:end\\s*-->\\s*$`);

export interface Scanned {
  readonly commands: CommandLine[];
  /** A start marker whose end never comes, by its line and name. */
  readonly unclosed: { readonly line: number; readonly name: string } | null;
}

/**
 * Whether a quote is left open at the end of `text`, given the one open at its
 * start. Single quotes take everything literally; inside double quotes a
 * backslash escapes the next character.
 */
export function openQuote(text: string, start: "'" | '"' | null = null): "'" | '"' | null {
  let q = start;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (q === "'") {
      if (c === "'") q = null;
    } else if (q === '"') {
      if (c === '\\') i += 1;
      else if (c === '"') q = null;
    } else if (c === '\\') {
      i += 1;
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) {
      return q;
    }
  }
  return q;
}

/** The command lines of every shell-labelled fence outside a marked block. */
export function commandLines(text: string): CommandLine[] {
  return scanFile(text).commands;
}

/** The command lines, and a marked block left open to the end of the file. */
export function scanFile(text: string): Scanned {
  const out: CommandLine[] = [];
  const lines = text.split('\n');
  let marked: { line: number; name: string; end: RegExp } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (marked !== null) {
      if (marked.end.test(raw)) marked = null;
      continue;
    }
    const mark = MARK_START.exec(raw);
    if (mark !== null) {
      const name = mark[1] as string;
      marked = { line: i + 1, name, end: markEnd(name) };
      continue;
    }
    const open = FENCE_OPEN.exec(raw);
    if (open === null) continue;
    const fence = open[2] as string;
    const label = (open[3] as string).toLowerCase();
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const shell = SHELL_LABELS.has(label);
    let heredoc: string | null = null;
    let quote: "'" | '"' | null = null;
    let pending: { line: number; text: string } | null = null;
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (close.test(line)) break;
      if (!shell) continue;
      if (heredoc !== null) {
        if (line.trim() === heredoc) heredoc = null;
        continue;
      }
      if (quote !== null) {
        quote = openQuote(line, quote);
        continue;
      }
      let cmd = line.trim();
      if (pending === null) {
        if (cmd.startsWith('$ ')) cmd = cmd.slice(2);
        else if (PROMPTED.has(label)) continue;
      }
      const text: string = pending === null ? cmd : `${pending.text} ${cmd}`;
      const at: number = pending === null ? i + 1 : pending.line;
      if (text.endsWith('\\')) {
        pending = { line: at, text: text.slice(0, -1).trimEnd() };
        continue;
      }
      pending = null;
      if (text !== '' && !text.startsWith('#')) out.push({ line: at, text });
      heredoc = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(text)?.[1] ?? null;
      quote = heredoc === null ? openQuote(text) : null;
    }
  }
  return { commands: out, unclosed: marked === null ? null : { line: marked.line, name: marked.name } };
}

interface Word {
  readonly text: string;
  readonly quoted: boolean;
}

/** One line split into simple commands, each a list of words; separators are unquoted. */
export function simpleCommands(text: string): Word[][] {
  const out: Word[][] = [];
  let words: Word[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  const endWord = (): void => {
    if (has) words.push({ text: cur, quoted });
    cur = '';
    quoted = false;
    has = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      const end = c === "'" ? text.indexOf("'", i + 1) : findDoubleEnd(text, i + 1);
      const stop = end === -1 ? text.length : end;
      cur += text.slice(i + 1, stop);
      quoted = true;
      has = true;
      i = stop;
      continue;
    }
    if (c === '\\') {
      cur += text[i + 1] ?? '';
      has = true;
      i += 1;
      continue;
    }
    if (c === '#' && !has) {
      endCommand();
      return out;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      endCommand();
      continue;
    }
    cur += c;
    has = true;
  }
  endCommand();
  return out;
}

function findDoubleEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** A word that stands for something: `<name>`, `…`, a glob, a variable, a brace list. */
export function isPlaceholder(word: string): boolean {
  return /[<>…*?$~{}[\]]|\.\.\./.test(word);
}

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/**
 * Words that run the command after them, each with the options that take the
 * next word as their value; the program after them is what a claim names.
 */
const PREFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['env', new Set(['-u', '-C', '-S'])],
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'])],
  ['time', new Set(['-f', '-o'])],
  ['nohup', new Set<string>()],
  ['nice', new Set(['-n'])],
  ['exec', new Set(['-a'])],
  ['command', new Set<string>()],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])],
]);
/** make flags whose value is the next word; `-j` and `-l` take one only when it is a number. */
const MAKE_VALUED = new Set(['-o', '--old-file', '--assume-old', '-W', '--what-if', '--new-file', '--assume-new', '-I', '--include-dir']);
const MAKE_NUMERIC = new Set(['-j', '--jobs', '-l', '--load-average', '--max-load']);
/** Runners whose first non-flag argument is the program they run. */
const RUNNERS = new Set(['node', 'tsx', 'node_modules/.bin/tsx', 'bash', 'sh', 'zsh', 'python', 'python3']);
/** Flags after which a runner has no program file: the code is inline. */
const INLINE = new Set(['-e', '-p', '-c', '--eval', '--print']);
/** Runner flags that take the next word as their value. */
const VALUED = new Set(['-r', '--require', '--import', '--loader', '--env-file', '-o']);
const PATH_WORD = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+$/;

export interface Claim {
  /** The simple command, as written. */
  readonly command: string;
  /** What the tree lacks, or null when the claim holds. */
  readonly lacks: string | null;
}

/**
 * The claims one command line makes, judged against the tree at `root`.
 * `targets` is the Makefile's target set, or null when there is no Makefile.
 */
export function judge(root: string, text: string, targets: Set<string> | null): Claim[] {
  const out: Claim[] = [];
  const exists = (p: string): boolean => fs.existsSync(path.join(root, p.replace(/^\.\//, '')));
  for (let words of simpleCommands(text)) {
    const command = words.map((w) => (w.quoted ? `"${w.text}"` : w.text)).join(' ');
    // A command prefix and its options, or an assignment, until the program.
    for (;;) {
      const first = words[0];
      if (first === undefined) break;
      if (ASSIGNMENT.test(first.text)) {
        words = words.slice(1);
        continue;
      }
      const valued = PREFIXES.get(first.text);
      if (valued === undefined) break;
      let k = 1;
      while (k < words.length && (words[k] as Word).text.startsWith('-')) k += valued.has((words[k] as Word).text) ? 2 : 1;
      words = words.slice(k);
    }
    const head = words[0];
    if (head === undefined) continue;
    // After a `cd`, every relative path and Makefile on the line is somewhere else.
    if (head.text === 'cd' || head.text === 'pushd') return out;

    if (head.text === 'make') {
      const rest = words.slice(1);
      if (rest.some((w) => ['-C', '-f', '--directory', '--file', '--makefile'].includes(w.text) || /^-[Cf]./.test(w.text))) continue;
      const args: Word[] = [];
      for (let k = 0; k < rest.length; k += 1) {
        const w = rest[k] as Word;
        if (!w.text.startsWith('-')) args.push(w);
        else if (MAKE_VALUED.has(w.text) || (MAKE_NUMERIC.has(w.text) && /^\d+(?:\.\d+)?$/.test(rest[k + 1]?.text ?? ''))) k += 1;
      }
      const named: string[] = [];
      for (const w of args) {
        if (w.quoted || ASSIGNMENT.test(w.text) || isPlaceholder(w.text)) break;
        named.push(w.text);
      }
      for (const t of named) {
        const lacks = targets === null ? 'the tree has no Makefile' : targets.has(t) ? null : `the Makefile has no target ${t}`;
        out.push({ command, lacks });
      }
      if (named.includes('gate')) {
        const stem = args.find((w) => w.text.startsWith('G='))?.text.slice(2);
        if (stem !== undefined && stem !== '' && !isPlaceholder(stem)) {
          const found = GATE_DIRS.some((d) => exists(`${d}/${stem}.ts`));
          out.push({
            command,
            lacks: found ? null : `no gate or generator ${stem}.ts under ${GATE_DIRS.join(' or ')}`,
          });
        }
      }
      continue;
    }

    let rest = words;
    if (head.text === 'npx' && words[1]?.text === 'tsx') rest = words.slice(1);
    const runner = rest[0] as Word;
    if (RUNNERS.has(runner.text)) {
      for (let i = 1; i < rest.length; i += 1) {
        const w = rest[i] as Word;
        if (INLINE.has(w.text)) break;
        if (VALUED.has(w.text)) {
          i += 1;
          continue;
        }
        if (w.text.startsWith('-')) continue;
        if (!w.quoted && !isPlaceholder(w.text) && !w.text.startsWith('/')) {
          out.push({ command, lacks: exists(w.text) ? null : `${w.text.replace(/^\.\//, '')} is not on disk` });
        }
        break;
      }
      continue;
    }

    if (!head.quoted && PATH_WORD.test(head.text) && !head.text.startsWith('node_modules/')) {
      out.push({ command, lacks: exists(head.text) ? null : `${head.text.replace(/^\.\//, '')} is not on disk` });
    }
  }
  return out;
}

export const spec: GateSpec = {
  name: 'claims',
  usage: 'usage: check-claims   (takes no arguments: a claim breaks when its target moves, anywhere)',
  run(ctx: GateContext): string {
    const makefile = path.join(ctx.root, 'Makefile');
    const targets = fs.existsSync(makefile) ? makeTargets(fs.readFileSync(makefile, 'utf8')) : null;
    const files = gitFiles(ctx.root, []).filter(isClaimFile);
    let claims = 0;
    let read = 0;
    for (const file of files) {
      const abs = path.join(ctx.root, file);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (isStamped(text)) continue;
      read += 1;
      const { commands, unclosed } = scanFile(text);
      for (const { line, text: cmd } of commands) {
        if (new RegExp(`#\\s*${OPT_OUT}\\b`).test(cmd)) continue;
        for (const claim of judge(ctx.root, cmd, targets)) {
          claims += 1;
          if (claim.lacks !== null) ctx.fail(file, `\`${claim.command}\` — ${claim.lacks}`, line);
        }
      }
      if (unclosed !== null) {
        ctx.fail(file, `<!-- ${unclosed.name}:start --> has no <!-- ${unclosed.name}:end --> on a line of its own, so nothing after it is read`, unclosed.line);
      }
    }
    return `[claims] ${claims} command claims in ${read} markdown files hold`;
  },
};

main(spec, import.meta.url);
