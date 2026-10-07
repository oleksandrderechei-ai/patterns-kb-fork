---
title: Golden Master
description: Compares fresh output against a saved known-good snapshot
area: testing
owner: Oleksandr Derechei
tags: [testing, maintainability, testability]
status: stable
aliases: [characterization test, snapshot test, approval test]
solves: [i have to refactor this code but there are no tests and nobody understands what it does, the output is a four thousand line blob and i am not writing an assertion for every field, "i just want to prove nothing changed after this rewrite, not check any one behavior", i changed one small thing and i am terrified something unrelated silently broke, nobody left on the team knows what this function is supposed to return]
---

# Golden Master

Freezes the system's current output as a trusted snapshot, then fails the instant a later run produces anything different — proof that nothing changed, without anyone having to specify what "correct" means.

## What it is
<!--meta block=description-->

A golden master test runs a system over a broad set of real inputs and pins today's output as a trusted file. Later runs diff fresh output against it: a match passes silently, and any difference fails until a person decides whether it is a regression or an intended change. It suits code with little coverage, output too large to assert field by field, or behaviour nobody understands well enough to say what correct is. Feathers calls it characterization testing.

## Explained
<!--meta block=explain-->

A golden master test runs a system over a wide set of real inputs, saves today's output as the approved copy, and on every later run compares fresh output with it. A match passes silently, and any difference, even one character, fails the test until a person reviews it. Choose it over hand-written assertions when the code has little test coverage, its output is too large to check field by field, or nobody can yet say what correct looks like, because you can pin down what it does now before you touch it.

- **Changed is not wrong.** A failure says something changed; a person reads every difference.
- **Unstable output.** Timestamps, random ids or unstable ordering fail for no reason; strip or fix them before comparing.
- **Bulk approval.** Approving many differences at once can wave through a real bug; approve in small steps and read each diff.
- **Pinned bugs.** It records current behaviour, bugs included; add direct assertions for the rules you know are right.

**Example.** A legacy invoice renderer has no tests. You run it over 500 real orders and save 500 outputs of about 4 KB, 2 MB in all. Every file differs on the print-time line, so you replace that line with a fixed value before saving. You then refactor the tax rounding, and 37 of the 500 invoices differ, 7.4 percent, each by one cent. You group the 37 diffs by cause, sample each group, confirm each is a one-cent rounding change, and approve the new copy. The cost is that the saved copy now also pins every other behaviour, wrong ones included, so you add direct tests for the rules you know, such as tax on a 100.00 order being 8.25.

## How it works
<!--meta block=structure-->

```mermaid caption="Fresh output is diffed against the saved golden file. A match passes silently; a difference forces a human to approve the new answer or flag a regression."
flowchart LR
    In["Real inputs"] -->|"feed"| Sys["System under test"]
    Sys -->|"produces"| Out["Fresh output"]
    Gold["Saved golden file"] -->|"baseline"| Cmp{"Diff against golden"}
    Out -->|"candidate"| Cmp
    Cmp -->|"match"| Pass["Test passes"]
    Cmp -->|"differs"| Review["Human approves or fails"]
```

## Variations
<!--meta block=variations-->

- **Approval Testing** — Tool-backed flavor (ApprovalTests, Approvals) that shows a diff and lets you approve a new golden file with one command instead of hand-editing it.
- **Snapshot testing** — Applied to a single function or component's return value, checked into the repo beside the test — the common form in frameworks like Jest.
- **Visual / pixel-diff regression** — The golden master is a rendered screenshot; fresh renders are compared pixel by pixel (Percy, Chromatic) instead of byte by byte.
- **Golden file testing** — Common in command-line interfaces (CLIs) and compilers: an input fixture is paired with an expected-output file on disk, and the test diffs real stdout or generated files against it.
- **Scrubbed / normalized master** — Timestamps, random IDs, and ordering are stripped or replaced with placeholders before comparing, so nondeterminism doesn't cause false failures.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Builds a safety net fast**, without first having to understand the code being pinned.
- **Catches any change in output** for the inputs it was run over, including ones nobody thought to assert on.
- **Cheap to write for large output**, but review cost grows with the number of master files and their size.
- **A common first move before refactoring legacy code** with thin coverage, if the output can be made deterministic.

### Cons
<!--meta polarity=con-->

- **A failing test says something changed**, not whether it's a bug — every diff needs a human to interpret.
- **Nondeterministic output causes false failures** unless scrubbed first (timestamps, random IDs, ordering). Environment differences such as locale or line endings also break it across machines; pin them in CI.
- **Approving a new golden** file can rubber-stamp a real regression if done carelessly or in bulk.
- **Encodes current behavior**, not intended behavior — it proves nothing about whether the master was ever correct.
- **Every intended change can produce many diffs**, so review fatigue grows with master size; keep masters small and split by area.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're about to refactor code** with little or no test coverage and need a safety net first.
- **The output is too large, complex**, or opaque to assert on piece by piece.
- **You need to show** that output is unchanged across a change, for a broad sample of inputs.

### Avoid when
<!--meta polarity=avoid-->

- **You're writing new code** where the correct behavior is already known — assert it directly instead.
- **The output is inherently nondeterministic** and hard to normalize before comparing.
- **A small, targeted example-based** test would be just as fast to write and far clearer to read, like [Arrange-Act-Assert](./arrange-act-assert.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal golden-master assertion"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

function assertGoldenMaster(name: string, actual: string): void {
  const path = `./__golden__/${name}.snap`;

  if (!existsSync(path) && process.env.CI) {
    throw new Error(`Missing golden master "${name}" in CI; approve it locally and commit it.`);
  }
  if (!existsSync(path) || process.env.UPDATE_GOLDEN) {
    mkdirSync("./__golden__", { recursive: true });
    writeFileSync(path, actual); // first run locally, or an explicit approval
    return;
  }

  const expected = readFileSync(path, "utf8");
  if (actual !== expected) {
    throw new Error(
      `Golden master mismatch for "${name}".\n` +
      `Re-run with UPDATE_GOLDEN=1 to approve, if the change is intended.`,
    );
  }
}

test("invoice renderer output", () => {
  const invoice = renderInvoice(sampleOrder);
  assertGoldenMaster("invoice-basic", invoice);
});
```

## In the wild
<!--meta block=wild-->

- **Jest snapshot testing** — Writes a component or value to a \`.snap\` file under \_\_snapshots\_\_ on first run and fails later runs on any diff; \`--updateSnapshot\` (or \`u\` in watch mode) blesses changes, \`--ci\` refuses to write new snapshots so a forgotten one fails, and property matchers like \`expect.any()\` cover nondeterministic fields. {#wild-jest-snapshots}
- **ApprovalTests** — On mismatch it launches a configured diff reporter and you approve by promoting the received file to the approved file; scrubbers normalize nondeterministic content, and the library ships for Java, .NET, Python and other languages. {#wild-approvaltests}
- **insta** — The Rust snapshot library; \`cargo insta review\` walks each changed snapshot for an accept-or-reject verdict, the INSTA_UPDATE environment variable controls update mode, and snapshots can be stored inline in the source file. {#wild-insta}
- **Chromatic** — Captures Storybook stories and pixel-diffs each against a per-branch baseline, requiring human sign-off on every visual change; TurboSnap skips stories unaffected by the git diff to cut the comparison set. {#wild-chromatic}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Scrubbers and normalizers** — Rules that strip or replace nondeterministic content — timestamps, random IDs, ordering — before the diff, so only meaningful changes fail the test.
- **Approval mechanism** — The explicit gate that blesses new output as the master — an update flag or an interactive accept/reject step — kept separate from a normal run.
- **Continuous integration (CI) write policy** — Whether a run in CI may write a missing master or must fail; letting CI write one turns a forgotten snapshot into a silent pass.
- **Input breadth** — The set of inputs the master is run against — wider coverage catches more, but every input is another file to review and keep current.

### Signals to watch
<!--meta polarity=signal-->

- **Snapshot churn** — How many master files a single change rewrites; a large bulk update is where a real regression gets laundered into the baseline.
- **Obsolete master count** — Master files no longer referenced by any test — they accumulate and get updated blindly unless pruned.
- **False-failure rate** — Tests failing on nondeterministic diffs rather than real behavior change — the signal that scrubbing is incomplete.

### Failure modes under load
<!--meta polarity=failure-->

- **Nondeterminism** — Timestamps, random IDs or unstable ordering differ every run, so the test fails for reasons unrelated to the code under test until they are scrubbed.
- **Bulk rubber-stamping** — Accepting every diff at once to make the suite green launders a real regression into the new master.
- **Unreviewably large masters** — A master too big to read gets approved without real inspection, so it verifies nothing.

### Readiness checklist
<!--meta polarity=check-->

- Nondeterministic fields are scrubbed or matched loosely before comparison.
- CI fails on a missing or changed master rather than silently writing one.
- New and changed masters are reviewed as a diff in code review, not bulk-accepted.
- Master files are committed to version control alongside the code they characterize.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Validation](../../themes/continuous-validation.md) — Catch output that changed when nothing should have {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strangler Fig](../distributed/coordination/strangler-fig.md) — Pins legacy output before each capability is replaced
- [Fake Object](./fake-object.md) — Fakes pin clocks and ids so diffs stay meaningful

**Alternative to**

- [Arrange-Act-Assert](./arrange-act-assert.md) — Snapshot the whole output vs. assert specifics

**Prevents**

- [Lava Flow](../../hazards/lava-flow.md) — Records what the system does today, so old code can be removed and a change in output is caught

<!-- relationships:end -->
