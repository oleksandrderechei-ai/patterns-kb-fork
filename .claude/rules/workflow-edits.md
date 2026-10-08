---
description: "How to change anything under .github/: which workflows a pull request runs, why a step name is a registry key, and why a problem matcher only annotates lines the branch touched. Use when editing a workflow or a problem matcher."
paths: [".github/**"]
---

# Editing CI

**Question:** how is a CI workflow edit tested?

Everywhere else in this repo a wrong change fails a check within seconds. Under `.github/`
that loop is shorter than it looks, because a workflow edit's first real run is often its first
test.

## What runs where

- `validate.yml` runs on every pull request, on a push to `main` and on dispatch: one named
  step per registered gate, and a `site` job that builds the site and runs the site gates.
- `docs-sweep.yml` runs on the 1st of every month and on dispatch. It checks nothing: its one
  step opens (or comments on) a "Docs sweep is due" issue that calls a session to the
  [docs-sweep](../skills/docs-sweep/SKILL.md) skill.
- `pages.yml` runs only on a push to `main` that touches `docs/`, `site/`, `tools/`, the
  lockfile, the Makefile or itself, and on dispatch. It builds the site with
  `make site-build`, deploys `site/dist`, and then a `smoke` job checks the deployed site
  ([Deployed site answers](../../docs/reference/triage.md#deployed-site-answers)); `smoke`
  can only mark the run red, since the site is already out. **Review an edit to it as
  production code** and dispatch it once by hand before trusting it; nothing on a pull
  request runs it.

## A step name is a registry key

In `validate.yml` a step's `name:` is compared byte for byte with a row's `ci_step` in
[gates.json](../../docs/data/gates.json), and its `run:` with the row's `wired`. A step that
checks nothing (an install, the matcher registration) is listed in `setup_steps` with its
reason. Change a step and the registry together, then run `make gates`, or the **Gate registry
in sync** gate fails. That gate compares text; it proves nothing about whether the YAML runs.

## A problem matcher only annotates the diff

[kb-gates.json](../../.github/problem-matchers/kb-gates.json) turns a finding line into an
inline annotation only on lines inside the pull request's diff. A finding in a file the branch
did not touch appears in the log and nowhere else, which looks exactly like a broken matcher.
Seed a test finding in a file the branch changed before concluding the wiring is broken.

The matcher's patterns follow the finding shapes in
[gate.ts](../../tools/src/lib/gate.ts); change a shape and the matcher in the same commit, and
`tools/src/lib/problem-matcher.test.ts` fails if the two drift.

## What holds it

The **Gate registry in sync** gate holds the step names and commands to the registry. Nothing
checks that a workflow runs; that is this rule and review.
