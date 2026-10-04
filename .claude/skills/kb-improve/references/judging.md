# Judging every hand-off

The main session never trusts a subagent's reply. Each hand-off has an acceptance test; a
reply that fails it goes back with the exact line that failed, and a page that cannot pass
is parked rather than landed half-right. This file is the test for each of the four
hand-offs and the ladder for a reply that fails one.

## The retry ladder

The same ladder at every hand-off:

1. **Correct.** Send the same agent the failing checks, quoted, and what a passing reply
   looks like. A named teammate gets it by message; an unnamed one is relaunched with the
   correction appended to its original prompt.
2. **Correct again**, once, if the second reply fails a different check. A reply that fails
   the same check twice is a brief the agent cannot follow, so skip to step 3.
3. **Restart fresh.** Launch a new agent of the same type with the original prompt plus a
   short "Known traps" line naming what the failed one got wrong. A fresh context sheds the
   wrong turn the old one is stuck in.
4. **Park the page.** Restore every file the page touched with
   `git show HEAD:<path> > <path>`, add its row to the pull request as **not accepted**
   with the check that kept failing, and move to the next page. Never land a page you
   would not accept.

Count the attempts per hand-off per page. Three failures at one hand-off end that page.

## 1. A reader's review

Accept it when all of these hold:

- It arrived whole: the `ROLE` line, the F lines and a closing `NONE-FOUND` line, with no
  "truncated" marker.
- `BLOCKS READ` names at least the blocks its brief says to read first, so the reader looked
  where its role points.
- Every F line has an anchor that `kb.mjs get` prints (or a block name, or
  `deepdives-dive-N`), a fix of at most 40 words, a rule naming a skill or a tone id, and a
  confidence.
- No F line asks to move, renumber or delete an item, except a claim it shows false.
- No F line reports a missing bold lead, link or `solves` phrase: `kb.mjs get` hides those.
- It stays in its role: a plain-language reader judging mechanism, or a practitioner
  grading prose, has drifted.

Correction to send, naming each failed check: "Your review of `<id>` fails: `<check>`.
Resend the full reply in the fixed shape, every F line under 60 words."

A reader with no findings and a `NONE-FOUND` that lists its first blocks is a pass.

## 2. The synthesizer's plan

Re-read the anchors yourself before you accept: `node scripts/kb.mjs get <id> --block <b>`
for every block an edit touches. Accept it when all of these hold:

- It has at most the cap of edits (8 by default), and each edit names its source roles and a
  rule.
- Every edit traces to a finding in the accepted reviews; an edit no reader asked for fails.
- No edit moves, renumbers or deletes an existing item, unless it removes a claim shown false
  and says so.
- Each instruction can be run as written: a `kb.mjs` writer command with all its arguments,
  or the exact replacement text for one anchor. "Improve the wording" fails.
- `NO-FABRICATION CHECK` covers every new name and number, and each one holds: a number is
  arithmetic you redo on figures the page already has, and a name is already on the page,
  in `kb.mjs related <id>`, or backed by a source the synthesizer names. Check one of each
  by hand.
- Word limits are met in the replacement text: description at most 80 words, explain text
  60–180, example at most 120, solves phrases at most 20.
- Every HIGH finding is either an edit or a `DROPPED` line with a reason.
- Conflicts between readers were settled by the order in personas.md, not by dropping both.

Correction: "Plan for `<id>` rejected: `<check>`, at `E<n>`. Return the whole plan with
that fixed."

A plan with no edits is accepted only when every HIGH finding has a `DROPPED` reason you
agree with.

## 3. The writer's edit

Read the diff yourself: `git diff -- <the page> docs/data/relations.json`. Accept it when all
of these hold:

- `node scripts/kb.mjs validate <id>` prints OK.
- The diff touches only the page, plus `relations.json` and the far page of an edge the plan
  named. Any other file fails.
- Every plan edit is in the diff or in the writer's skipped list with a reason, and nothing
  is in the diff that the plan did not ask for.
- No list item moved; a replaced item kept its place and its neighbours' lead form.
- Every link the old text carried is still there, and new links use the page's own relative
  path style.
- After an essence or `solves` change, `make gate G=check-search-oracle` passes.
- Read as a whole, each changed passage is true and clearer than the one it replaced.

Correction: name the edit and the check, with the exact text it should hold. A writer that
damaged the page is not corrected in place: restore the page with
`git show HEAD:<path> > <path>` and restart the writer fresh with the same plan.

## 4. The page

Before the commit, `make gen && make validate-changed` passes. A red gate is fixed through
the [gate-red](../../gate-red/SKILL.md) skill when the fix is mechanical; when it needs a
content change, it goes back to hand-off 3 as a correction. Then the page is accepted and
committed on its own.
