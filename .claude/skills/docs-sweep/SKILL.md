---
name: docs-sweep
description: "Check that docs and harness files are still true: fan the claim-audit agent out over the docs map, re-check each finding, fix small ones on one branch, list the rest on one issue. Use when the \"Docs sweep is due\" issue opens, after a change many pages describe, or when asked if the docs still hold. Not for links, style or frontmatter (gates)."
---

# Sweep the docs for claims that stopped being true

Gates prove a page is well formed, not that it is true. A page can pass every gate and still
name a command that is gone, a flag a script dropped, a count that grew or a branch the code no
longer takes. The [claims rule](../../rules/claims.md) fixes a claim in the change that breaks
it and the claim gate holds the commands in shell fences; this sweep reads the rest, on the
schedule `.github/workflows/docs-sweep.yml` keeps.

1. **Enumerate.** Walk the map, `docs/README.md`, two levels deep, plus the top-level markdown
   files and every directory's `CLAUDE.md`. Write down each page you skip, with its reason:
   a generated reference page such as `docs/reference/gates.md`, whose freshness gate owns it.
   A generated marked block inside a page is skipped the same way; the rest of the page is
   swept.
2. **Fan out.** Group the pages by area, plus one group for the top-level files. Hand each group to the [claim-audit](../../agents/claim-audit.md) agent in
   one call and ask for its fixed reply, nothing else. Do not read the pages yourself: that
   reading belongs in the agent's context, not yours.
3. **Believe nothing.** For each finding, re-read both cited lines, the page's and the tree's,
   and run any command it names. Drop what does not hold, and keep the reason for every drop.
4. **Split the findings.** Ask of each: can it be fixed with no product judgment in under an
   afternoon? If yes, fix it on the sweep's one branch; a red gate met on the way is the
   [gate-red](../gate-red/SKILL.md) skill. If not, or when the pile is large, list it on one
   GitHub issue grouped by page, each finding in the agent's line shape, with the sweep date and
   every drop with its reason. A taste call goes on the same issue; a trap goes to the [inbox](../../../docs/inbox.md).
5. **Gate the branch.** Run the whole set on the sweep's branch before it merges:

   ```bash
   make validate
   ```

6. **Close.** When the "Docs sweep is due" issue called this run, comment the trace on it —
   pages covered, findings kept and dropped, the branch and the grouped issue — then close it.

## Done means

- Every map row is in an agent's `checked:` line or in the skip list with its reason.
- Every believed finding is merged from the one branch, green on `make validate`, or listed on
  exactly one issue.
- No claim was fixed by deleting it.
- The due issue, when there was one, carries the trace and is closed.
