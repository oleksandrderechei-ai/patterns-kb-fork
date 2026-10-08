---
name: kb-explain
description: "Write or audit a page's Explained block: one expert-grade paragraph in plain words, a costs list (required on a pattern), one simple example. Use when someone says 'write the explain block', 'the explanation is too jargon-heavy', 'add the costs list', 'audit explain blocks'. Not for a design's levels rubric (kb-design-levels)."
---

# Authoring the Explained block

**One depth for every reader.** A page has no reading levels. Its `explain` block is ONE
explanation that an expert would sign, written in plain words so anyone gets the idea, plus
a short list of what it costs and ONE simple example that shows the depth at work. Nothing is stacked, nothing is hidden, and
no `{level=…}` mark exists anywhere.

**A page passes this skill when a newcomer can follow the explanation word by word and a
staff engineer finds nothing wrong or missing in it.** Judge the block as the reader meets
it (`kb.mjs get <id> --block explain`), never the raw file.

## The contract

The block has one fixed shape, held by [KB-014](../../../docs/reference/page-rules.md#KB-014):

```
## Explained
<!--meta block=explain-->

<one paragraph, 60–180 words, no bold run-in label>

- **<cost, a bold lead>.** <what it costs and the counter-move, at most 25 words in all>
- **<cost>.** <…>

**Example.** <one paragraph, at most 120 words>
```

- The costs list is 2 to 4 bullets, each opening with a bold lead and running at most 25 words
  in all. It is required on a **pattern** and optional on every other kind that has an
  explain block (see "The costs list").
- The paragraph may link a term on its first use to that term's own page, a relative link to
  the page's `.md` (`[bulkhead](../resilience/bulkhead.md)`), or gloss it in a short
  parenthesis. Link only a page the corpus has, and never the page's own subject.
- The example may instead be ONE captioned non-mermaid sketch fence of at most 25 lines,
  when code or data is the clearest proof (see "The example").
- No `**Basic.**` or other bold run-in label opens the explanation. The heading says what it is.
- No italics, no `{level=…}` suffix, no second or third paragraph. Plain text, `code` spans
  and the links above only; bold appears in the costs leads and in `**Example.**`.
- Every kind carries the block except **design**, which may leave it out (see "When a design
  skips it").

## What "expert-grade in plain words" means

The depth is the same an expert would want; only the words change. Five things must be
present, in this order of weight (the third lives in the costs list, the rest in the paragraph):

1. **The mechanism, named plainly.** The first sentence says what the thing does and what
   that buys you (TONE-004). "A circuit breaker is a gate in front of one dependency that
   counts recent failures and, once there are too many, answers at once from a fallback."
   Never a pattern name standing in for the explanation: "it is a bulkhead" explains nothing,
   and "it isolates failures like a bulkhead" explains only to someone who knows bulkheads.
2. **The selection criterion against the nearest alternative.** Say when to choose this over
   the thing you would otherwise reach for, in the reader's situation (TONE-005). "Choose it
   over a plain timeout plus retry when the dependency is slow rather than down."
3. **The dominant costs and their counter-moves**, in the costs list, not the paragraph. Name
   the two to four costs that bite most, each with what you do about it (TONE-003). A cost
   with no counter-move is a complaint. Where a counter-move is another pattern, name the
   pattern AFTER saying what it does.
4. **Every term linked or glossed on first use, or avoided.** If a newcomer would have to look
   a word up, link it to its page, define it in a short parenthesis, or write the plain
   version. Prefer avoiding: "copies of your service" beats "replicas", "waiting" beats
   "blocking on I/O". The glossary's banned words are banned here too.
5. **A failure told concretely.** What goes wrong without it, as a branch the reader can
   picture (TONE-006), inside the same paragraph. No separate story paragraph.

**TONE rules that bind here:** TONE-001 second person where you give advice; TONE-002 one
concept per sentence (its 2–3 sentences per paragraph gives way to the word bound, see Sizing); TONE-003 every claim carries its consequence;
TONE-004 open with the mechanism; TONE-005 applicability as the reader's situation;
TONE-006 failure branches; TONE-008 no hedging stacks, no unpriced adjectives, so a figure or
a mechanism replaces "robust", "scalable", "significant"; TONE-009 no italics.

**Plain words, not fancy ones.** Short common words. No "orchestrate" or
"idempotent" without a gloss, and none of the house words the glossary bans. A long sentence is
two sentences.

## The costs list

After the paragraph, 2 to 4 bullets say what the subject costs. Each opens with a bold lead
that names the cost in two or three words, then says what it costs and, when there is a short
one, what you do about it, in at most 25 words in all (the lead counts). One cost per bullet;
a bullet is one paragraph with no nested list. A pattern always has costs, so the list is
required there and the gate fails a pattern without one. On a hazard, theme, principle,
capability or comparison it is optional: write it when the subject has costs to price, and
leave it out when the paragraph already says all there is. The costs are not the page's
`tradeoffs` block in miniature; they are the few things a reader should know before reading
on, and the tradeoffs block argues each side at length.

## The example

**ONE simple example that shows the depth.** It is a concrete scenario with real numbers or a
real system, small enough to hold in the head, and it must show three things:

- the mechanism at work (what happens, step by step, with the numbers);
- the failure the mechanism prevents, or the cost it adds;
- the cost the explanation named, paid once on the page.

Rules:

- **Numbers or a named real system.** "A checkout with 200 threads and a 1 s timeout", not "an
  e-commerce site". Use only figures you can work out from the scenario; never invent a
  product feature (anti-fabrication, as in `wild`).
- **A sketch fence only when code is the clearest proof**: a config, a query, a five-line
  snippet that the prose would only describe. At most 25 lines, one captioned non-mermaid
  fence, in a language from the sketch list ([KB-010](../../../docs/reference/page-rules.md#KB-010)),
  written with `--example-lang` and `--example-caption`.
- **Never repeat the page's `sketch` or `structure` blocks.** The example is a scenario run,
  not the diagram again and not the code sample again. If the sketch already holds the code,
  the example is prose.
- **Shows depth, not warm-up.** An example that only restates the first sentence with a
  story ("imagine a restaurant…") fails. Everyday comparisons belong in the explanation,
  one sentence at most.

## The writer

```
node scripts/kb.mjs get <id> --block explain                         # read the current block first
node scripts/kb.mjs explain <id> --text "…" --costs '[{"lead":"…","note":"…"}]' --example "…"
node scripts/kb.mjs explain <id> --text "…" --example "<code>" \
  --example-lang typescript --example-caption "How does …?"          # sketch example
```

`--text` takes `[label](path.md)` for a link, and a cost note takes one the same way.
`--costs` takes the bullets as a JSON array of `{lead, note}`; leave it out and the writer keeps
the page's own list, pass `'[]'` to drop it.
`kb.mjs get <id> --block explain --json` dumps the current text, costs and example in the
shape the writer takes. The writer replaces the whole block and refuses a shape KB-014
rejects (a bold run-in label, two paragraphs, a missing costs list on a pattern, a bullet
without a bold lead or past 25 words, a mermaid fence, a fence past 25 lines, a level mark). Write the explanation
through it, never by typing the block by hand. After an edit run `node scripts/kb.mjs
validate --file docs/<…>.md`. Run `make gen && make validate` once no authoring agent is
still writing: `make gen` rewrites every generated block in the corpus, so a run that races
an agent's write can clobber it.

## Sizing

One bound for every kind, held by KB-014: the explanation runs 60–180 words, the costs list
2 to 4 bullets of at most 25 words each, and the example at most 120 words (or a sketch of at
most 25 lines). Count with
`node scripts/kb.mjs get <id> --block explain | wc -w`. A small page gets the short end; it is
never padded to reach the long one. This is the one block where TONE-002's 2–3 sentences per
paragraph gives way to the word bound: the paragraph may run longer than three sentences as long
as each sentence holds one concept.

## When a design skips it

`explain` is mandatory on every kind except **design**, where the `optional` list in
`docs/data/content-model.json` makes it skippable. A case study already argues in full through
its interview, its sizing, its deep dives and its rubric, so a one-paragraph summary of those
blocks repeats the page in miniature.

Keep it when the design turns on one counter-intuitive idea the reader needs BEFORE the
interview makes sense, and the paragraph says something no other block says. Drop it when it
only compresses blocks the page already has. Dropping is deleting the `##` heading, the
`<!--meta block=explain-->` line and the two paragraphs; the `kb-shape` gate accepts the page
without it. `kb.mjs new --kind design` scaffolds no explain block.

## The audit procedure

For each page, read the block with `kb.mjs get <id> --block explain` and score these six
checks, pass or fail. A page passes at 6 of 6; any fail is fixed with the writer.

1. **Shape.** One paragraph of 60–180 words, no bold run-in label, no italics, no level mark,
   then a costs list of 2 to 4 bold-led bullets of at most 25 words (required on a pattern),
   then `**Example.**` with at most 120 words, or one captioned non-mermaid fence of at most
   25 lines. (KB-014 decides this mechanically; check the word counts yourself too.)
2. **Mechanism first.** The first sentence says what the thing does and what that buys, in
   words a newcomer can follow. It does not just name the pattern or define it by category
   ("X is a structural pattern that…").
3. **Selection against the nearest alternative.** The paragraph names the alternative a reader
   would otherwise pick and says in which situation to choose this one instead.
4. **Dominant costs and counter-moves.** The costs list names the main costs, and each bullet
   carries what you do about it. A bare list of downsides fails, and a cost stuffed into the
   paragraph instead of the list fails.
5. **Every term linked, glossed or avoided.** Read it as a newcomer: every word that needs a
   lookup is linked to its page, defined in place or replaced, and no glossary-banned word
   appears. No pattern name is used as if it were the explanation.
6. **A working example.** Concrete scenario with real numbers or a real system, it shows the
   mechanism and the cost at work, every number in it follows from the others (redo the
   arithmetic), and it does not repeat the page's `sketch` or `structure` block.

For a sweep, the orchestrator hands each worker a disjoint set of ids, each worker returns
one line per id (`<id> — <pass | fail: 2,5> — <what it rewrote>`), and `make gen && make
validate` runs once after the batch goes quiet.

Never hide the hard part to keep the paragraph short, and never pad it to reach the range. If
a page is honestly small, say the small true thing and stop.

## Worked example — circuit-breaker

The rewrite keeps the selection, moves the four costs into the costs list, says them in plain words, and adds a scenario.

Read first: `node scripts/kb.mjs get circuit-breaker --block explain`. Then:

```
node scripts/kb.mjs explain circuit-breaker --text "A circuit breaker is a gate in front of one dependency. It counts recent failures and, once there are too many, stops sending calls and answers at once from a fallback, such as a cached value or a plain error. Without it, a slow or dead dependency still costs a full wait per call, so every thread in your service ends up waiting and the healthy parts starve. With it, the failed calls cost nothing and the sick service gets quiet time to recover. After a cooldown the gate lets one trial call through: if it works, the gate closes again; if not, it stays open. Choose it over a plain timeout plus retry when the dependency is slow rather than down, because a timeout limits one call while a breaker limits the attempts of every copy of your service together." \
  --costs '[{"lead":"Tuning.","note":"Thresholds depend on your traffic, so test them against a service made slow, not one switched off."},{"lead":"Hidden trouble.","note":"An open gate hides a half-healthy service, so keep health checks running."},{"lead":"Local counters.","note":"Counters kept in each process mean every copy learns of an outage alone, so share the state if they must trip together."},{"lead":"Stampede.","note":"When the cooldown ends every caller rushes in, so allow just one trial call."}]' \
  --example "Checkout calls a fraud-check service that answers in 50 ms. Checkout has 200 threads, takes 100 requests a second and times out fraud calls after 1 s. The service slows to 10 s. Without a breaker, 100 requests a second times 1 s ties up about 100 threads and makes every checkout a second slower; a retry per failure, or double the traffic, needs all 200 and the site stalls. With a breaker set to open after 20 failures in 10 s, it opens about 1.2 s after the slowdown and checkout answers in milliseconds again, queuing orders for manual review. That costs a review backlog while it stays open. Every 30 s one trial call tests the service."
```

The block it writes:

```
## Explained
<!--meta block=explain-->

A circuit breaker is a gate in front of one dependency. It counts recent failures and, once
there are too many, … (the paragraph above, unwrapped)

- **Tuning.** Thresholds depend on your traffic, … (the four bullets above)
- **Hidden trouble.** An open gate hides a half-healthy service, …

**Example.** Checkout calls a fraud-check service that normally answers in 50 ms, … (the
paragraph above, unwrapped)
```

Counts: explanation 141 words (limit 60–180), four costs of 14 to 24 words (limit 25, lead
included), example 119 words (limit 120, label included in neither count).

The arithmetic behind the example: 100 requests a second times a 1 s timeout is 100 threads
held at any moment (of 200); a retry per failure doubles the load to 200 a second, which needs
all 200 threads; the first failure lands 1 s after the slowdown, at 100 failures a second, so the
20th is 0.2 s later, at about 1.2 s.

Why it passes the six checks: (1) shape and counts hold; (2) the first sentence names the
gate and, in the second, what it does; (3) the alternative is a plain timeout plus retry and the
situation is "slow rather than down"; (4) four costs in the list, each with its counter-move (test against
a slow service, keep health checks running, share the state, allow one trial call); (5) "fallback" is
glossed in place, "half-open", "replica", "fleet" and "threshold tuning" never appear; (6) the
numbers come from the scenario, the example shows the stall, the 1.2 s opening and the review
backlog as the paid cost, and it repeats neither the page's flowchart nor its sketch.

## Done means

- The block is one paragraph of 60–180 words, a costs list of 2 to 4 bullets (required on a
  pattern) and one example (at most 120 words, or one captioned non-mermaid fence of at most
  25 lines), written through `kb.mjs explain`.
- It scores 6 of 6 on the audit, read as the page shows it (`kb.mjs get <id> --block explain`).
- No bold run-in label, no italics and no `{level=…}` mark appears anywhere in the block.
- `node scripts/kb.mjs validate --file docs/<…>.md` is clean, and `make gen && make validate`
  exits 0 once no authoring agent is still writing.
