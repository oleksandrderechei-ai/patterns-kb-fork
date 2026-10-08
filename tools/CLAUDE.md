# Working in tools/

The repo's programs: the check gates (`src/gates/`), the generators (`src/gen/`), the site
build's steps (`src/site/`), their shared library (`src/lib/`, with the markdown
[dialect](src/lib/dialect.md) the pages are written in), the driver behind `make validate`
(`src/run-gates.ts`), kb.mjs over `docs/` (`src/kb/`, launched by `scripts/kb.mjs`), the
retrieval contract (`src/contract/`: the published JSON Schemas and the contract names; a
schema only gains keys within its major version, anything else is a new major) and the
reader's flows over the built site (`e2e/`, Playwright, run by `make site-e2e`). It is
the npm workspace the root installs with `make install`; nothing else here ships with the
site.

```bash
make tools-test            # the vitest suite with coverage; one file: add T=<name>
make gate G=check-json     # one gate alone
make gates                 # rewrite the gate reference after a registry edit
make gen                   # run every generator
```

## Conventions

- **The gate contract is a function**, [src/lib/gate.ts](src/lib/gate.ts): exit 0 with one
  summary line, 1 with findings on stderr, 2 on misuse. Write a `GateSpec` and end the file
  with `main(spec, import.meta.url)`.
- **A registered gate is five pieces:** the program, its sibling test, a row in
  [gates.json](../docs/data/gates.json), a named step in `.github/workflows/validate.yml`,
  and a [triage](../docs/reference/triage.md) section at the row's runbook anchor.
  `check-gates-sync.ts` names whichever is missing.
- **A generator writes through [src/lib/generated.ts](src/lib/generated.ts)**, stamping what
  it owns, and answers `--check`.
- **Every module under `src/` has a sibling test.** Test a gate end to end in the sandbox from
  [src/lib/sandbox.ts](src/lib/sandbox.ts), with a pass, a fail and a misuse case; a fixture
  a second suite needs goes in `src/lib/fixtures.ts`.

## Don't

- **Don't lower a coverage floor** in [vitest.config.ts](vitest.config.ts), or exclude a
  file to meet one. The floors only rise.
- **Don't add a runtime dependency or an install script.** Pin `devDependencies` exactly;
  the root `package.json` denies every install script.
- **Don't list a gate in the Makefile.** The driver reads `local_command` from the registry.
- **Don't register a raw tool as a gate.** npm swallows an unknown flag and exits 0; wrap the
  tool the way `check-types.ts` and `check-suite.ts` do.
