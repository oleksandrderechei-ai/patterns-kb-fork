---
title: Trap inbox
description: Traps that bit a session and have no home yet — one bullet each, at most 20 — and the ladder an entry leaves by.
area: reference
owner: Oleksandr Derechei
tags: [operations, maintainability]
status: stable
---

# Trap inbox

A trap is a mistake this repo lets a session make: a command that answers wrong, a file
that looks hand-written and is not, a rule nobody wrote down. Write it here the day it
bites, because a fresh fact is cheap to record and expensive to rediscover. Take it out the
day it gets a real home.

An entry is one top-level bullet that opens with a bold phrase: the trap first, then what to
do instead. It runs to at most 8 non-blank lines, and the page holds at most 20 entries.
`make gate G=check-inbox` holds both limits and prints the count on its summary line. Read
that line, not only the exit code: a trap written as a heading or a plain bullet is not an
entry, and the count shows it.

## When an entry leaves

An entry leaves in the change that lands its new home, and that change deletes it. Never
rewrite an entry in the past tense: git holds the history. Take the first tier that honestly
fits:

1. **A gate or a test**, when the trap leaves evidence in the tree: a file that disagrees
   with another, a path that does not resolve, a list with two copies.
2. **A comment beside the code**, when whoever would make the mistake is already reading
   that file.
3. **A numbered rule**, when the trap says what a page or data file must be: a row of
   [page-rules.md](reference/page-rules.md) when a gate decides it, else
   [markdown-authoring.md](../.claude/rules/markdown-authoring.md) or [tone.md](../.claude/rules/tone.md).
4. **A directory's layer**, for an operating rule in that directory. A layer at its budget
   takes the new line only by moving another one out to its home.
5. **The triage page**, [reference/triage.md](reference/triage.md), when the trap explains
   what a red gate means.
6. **A guard row plus a test case**, when a command exits 0 with a wrong answer: a row in
   `.claude/hooks/guard-commands.sh` and a case that proves the deny and the corrected form.

A trap that fits no tier is usually two facts in one bullet. Split it and route each half.

## Open traps

- **A retired word passes every gate.** The owner retired `terminal` (say open or finished),
  but no `avoid` list in `docs/data/glossary.json` names it; the vocabulary gate already bans
  `mint` and `derive` in every form. Check new prose by hand:
  `grep -rniE '\bterminal\b' CLAUDE.md docs .claude/rules`.
  Leaves when `terminal` joins a `house` term's `avoid` list.
- **The block writers escape what the rules say they keep.** `kb.mjs production` and `wild`
  wrote `` \` `` around an inline-code name (`max.poll.interval.ms`) that markdown-authoring
  says passes through, and `kb.mjs explain --costs` turned a `[label](path.md)` link in a
  cost note into escaped text. After each writer call, check the page file: `grep -n '\\'
  docs/<path>.md`, and restore the backtick or link by hand. Leaves when the writers pass
  inline code and cost links through, with a test case for each.
