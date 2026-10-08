# Working in scripts/

Three files every other part of the repo calls by path, so they stay here while the programs
live under [tools/](../tools/CLAUDE.md).

- [kb.mjs](kb.mjs): the reader and writer over the knowledge base, your interface to it. A
  thin launcher: the program is `tools/src/kb/cli.ts`, its command surface
  `tools/src/kb/spec.ts`. `node scripts/kb.mjs` alone prints every command and flag.
- [fm-json.sh](fm-json.sh) and [lib-frontmatter.sh](lib-frontmatter.sh): THE one frontmatter
  parser. Every gate, generator and kb.mjs reads a page's frontmatter through it
  (`tools/src/lib/frontmatter.ts` is the door on the TypeScript side).

```bash
node scripts/kb.mjs validate --file docs/hazards/deadlock.md   # one page's shape
KB_ROOT=<tree> node scripts/kb.mjs ls                         # another tree
```

## Conventions

- **kb.mjs needs the tools workspace.** Without `node_modules` it says to run
  `make install` and exits 2.
- **kb.mjs exits 0 when done, 1 when the KB refuses a well-formed call (fix the content), 2
  when the call is malformed (fix the command).** An empty result is done. An unknown id or
  block, a `validate` that finds problems, a `resolve` that finds a citation not ok and a
  writer that refuses the content are 1. An unknown command or flag, a flag with no value
  (`-n` for `--n` included), a missing id, query or required flag, and a value of the wrong
  form (JSON that does not parse or has the wrong shape, `--favourite` not true or false,
  `--order` not a whole number) are 2. A failed call says why on stderr and prints nothing
  on stdout, except `validate --json` and `resolve`, whose findings are the answer: they
  print it and still exit 1.
- **`KB_ROOT` points kb.mjs at another tree**, as the tests do.
- **A new kb.mjs command is one entry in `tools/src/kb/spec.ts`**, with its handler in
  `cli.ts` or `write.ts` and a test beside it.

## Don't

- **Don't add a program here.** A gate or a generator is TypeScript under
  [tools/](../tools/CLAUDE.md), with a registry row.
- **Don't write a second frontmatter parser.** Read through `fm-json.sh`, or its door.
- **Don't move kb.mjs.** Every skill, agent and layer names this path.
