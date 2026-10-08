---
title: Rule of Three
description: "Tolerate the first duplicate and extract on the third, when you can see what really varies"
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, abstraction, maintainability]
status: stable
aliases: [Three strikes and you refactor]
solves: [I merged two similar functions and now every new caller needs another flag, should I extract this helper now or wait until it appears again, a shared abstraction we made too early fits none of the new cases, I keep copy-pasting a block and cannot tell when to unify it]
---

# Rule of Three

Copy code the second time, and extract the shared piece on the third, when you can see what actually varies.

## What it says
<!--meta block=description-->

The rule of three says: do a thing once, tolerate the duplicate the second time, and refactor on the third. Martin Fowler credits it to Don Roberts in his book Refactoring, as "three strikes and you refactor". It is a rule about timing, not about counting lines. Two examples show a coincidence, and three show a pattern, so the wait gives you enough evidence to choose the right abstraction.

## Explained
<!--meta block=explain-->

The rule of three says: write it once, copy it the second time, and extract the shared piece the third time. You wait because an abstraction built from one or two examples is a guess about what varies, and a wrong guess is harder to undo than the duplication it removed, since every caller depends on it. With three cases you can see what is the same and what differs, so the shared code holds the first and takes the second as an argument. Choose it over extracting at once when the copies may change for different reasons. Extract at the second copy when they are one fact, such as a tax rate, because [DRY](dry.md) matters more there than waiting. The cost is a tolerated copy for a while, so leave a comment pointing to it and treat the third case as a real trigger.

**Example.** A team writes a CSV export for orders, then copies it for refunds, changing two columns. At the third request, invoices, the three versions show that columns vary and the joining and quoting never do. One toCsv function with a column list replaces 3 copies of 14 lines, and a quoting bug is fixed in one place. Had they extracted after the first copy, they would have guessed the orders layout, and the refund and invoice cases would have needed 2 flags. The cost was one extra copy kept for 3 weeks, with a comment marking it, and the counter-move to forgetting it was that comment.

## Why it helps
<!--meta block=rationale-->

An abstraction built from one example guesses which parts will vary, and built from two it still guesses. The guess hardens into a shared function, then callers bend to it, and the next case needs a flag, then another flag. The defect is a shape fitted to too little evidence, which costs more to undo than the duplication it replaced, because every caller now depends on it.

Waiting for the third case lets the real axis of variation show. What stays the same goes into the shared code, and what differs becomes the parameter or the hook. You pay for two copies in the meantime, which is cheap and easy to remove, in return for a shared piece that fits.

## Applying it
<!--meta block=applying-->

Count real cases, then decide:

- **First time: just write it.** Do not design for a reuse you cannot yet see.
- **Second time: copy, and mark it.** Leave a short comment pointing at the first copy, so the duplicate is findable.
- **Third time: extract.** Compare the three, keep what is identical in the shared code and turn each difference into an argument or a small strategy.
- **Check the reason to change.** Extract only if the copies change for the same reason. Three look-alike pieces that change for different reasons stay apart.
- **Extract sooner for knowledge, later for shape.** A business rule or constant that must stay in sync deserves a single home at the second copy, since the cost is a wrong answer.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — two copies kept, then one extraction once the third shows what varies"
// Two near-copies: tolerated. Which part varies is still a guess.
const csvOrders  = (rows: Order[])  => rows.map(r => [r.id, r.total].join(",")).join("\n");
const csvRefunds = (rows: Refund[]) => rows.map(r => [r.id, r.amount].join(",")).join("\n");

// A third copy (invoices) shows the real shape: the columns vary, the joining does not.
function toCsv<T>(rows: T[], columns: (r: T) => (string | number)[]): string {
  return rows.map(r => columns(r).join(",")).join("\n");
}
const orders   = (rows: Order[])   => toCsv(rows, r => [r.id, r.total]);
const refunds  = (rows: Refund[])  => toCsv(rows, r => [r.id, r.amount]);
const invoices = (rows: Invoice[]) => toCsv(rows, r => [r.id, r.number, r.due]);
```

## Taken too far
<!--meta block=overreach-->

Counting is a proxy, and the rule fails when you follow it as arithmetic. Three copies that change for different reasons are still not one thing, and merging them is the wrong abstraction. Equally, two copies of a rule that must stay in sync, such as a tax rate, are one fact written twice, and waiting for a third just waits for the bug.

The rule also makes a cost easy to ignore: each tolerated copy is a place to fix a bug, and a team that never gets to the third occurrence, or never notices it, keeps the duplicates for years. Set a reminder where you leave the second copy, and treat the third as a real trigger rather than a suggestion.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Don't Repeat Yourself (DRY)](./dry.md) — Says when to remove duplication: on the third copy, not the second
- [You Aren't Gonna Need It (YAGNI)](./yagni.md) — Waits for evidence before building a shared abstraction
- [Vertical Slice](../patterns/architecture/vertical-slice.md) — Tolerates duplicated code until a third copy shows what is really shared
- [Design for Evolution](./design-for-evolution.md) — Lets the right abstraction emerge from real cases, not guesses
- [Open/Closed Principle](./open-closed.md) — Wait for the second or third real variant before laying the seam.

<!-- relationships:end -->
