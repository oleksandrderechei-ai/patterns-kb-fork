---
name: kb-grill-design
description: "Quiz the reader on a KB case study in batched rounds, graded against the page and its Mid/Senior/Staff+ rubric, ending in a gap list of cited ids. Use when someone says 'grill me on bitly', 'quiz me on this design', 'drill me'. Not for other page kinds (kb-grill-page), new proposals (grill-me) or open talk (kb-discuss)."
---

# Grilling a reader on a case study

**The deliverable is a scored gap list, not a lecture.** You ask; they answer; you grade
against the page and cite where the answer lives. The failure mode this skill exists to
prevent is teaching instead of testing — the moment you explain the design, the reader
stops retrieving and starts reading, and retrieval is the whole point.

The corpus is millions of tokens. **Never open a page file — `docs/**.md`, or the HTML
`make site-build` writes.** Everything comes through `node scripts/kb.mjs`.

## 1. Resolve the page and load the answer key

A name, a `file://` URL, a `docs/designs/<id>.md` path or a built
`site/dist/designs/<id>.html` all resolve the same way: the id is the basename minus `.md`
or `.html`. With nothing named, offer a few via `kb.mjs ls --kind design`.

Read the page block by block as you need it — not all at once, and never the whole page
before round 1. You only need a block to grade the round that covers it.

```
node scripts/kb.mjs ls --kind design                    # when no page was named
node scripts/kb.mjs get bitly --block requirements      # ~180 tokens, not ~4k
node scripts/kb.mjs get bitly --block deepdives         # the heaviest round's key
node scripts/kb.mjs get bitly --block levels            # the grading rubric
```

Read `levels` early. It is the page's own Mid / Senior / Staff+ (or Junior / Mid /
Senior on a `low-level-design` kata) rubric of demonstrable behaviours, and it is what
you grade against at the end — not your own opinion of a good answer.

## 2. The rounds

Ask through the question UI (AskUserQuestion), **up to 4 questions per round**. Rules
per question:

- **Never quote the answer into the question.** "The page says codes come from a
  counter — why?" has already been answered. Ask "how would you guarantee two links
  never collide?" and let them produce the counter.
- **Options are honest alternatives.** Multiple choice is a recall aid, not a giveaway:
  every distractor must be a design somebody has really shipped, and each option's
  description states its consequence, not its verdict. Where free recall is the point
  ("trace a read end to end"), say so in the question and let them use Other.
- **One topic per question.** Never compound. Split it or drop the weaker half.
- **Build on the answers.** A wrong answer earns a follow-up in the next round, not a
  correction on the spot. A right answer earns the harder version of itself.
- **Grade silently until the end.** Do not mark each answer as it arrives — the reader
  is calibrating against your reactions rather than against the material.

**Hard cap: 6 rounds.** A grill that has not found the gaps in six rounds is measuring
patience.

## 3. The ladder

One round per group, in the page's own block order, skipping any block the page does not
carry (`sizing` is absent on all nine `low-level-design` katas):

| round | block | what you are testing |
|---|---|---|
| 1 | `requirements` | the FRs from memory, and the NFR **numbers** — a remembered NFR without its figure is not remembered |
| 2 | `sizing` | the back-of-envelope, and which candidate technology was **rejected** and why |
| 3 | `entities` + `interface` | the core entities and the endpoint surface, grouped by caller |
| 4 | `architecture` | free recall: name the components and trace one request end to end |
| 5 | `deepdives` | the heaviest round — one question per dive |
| 6 | `tradeoffs` + `relationships` | the biggest flaw, and which patterns it demonstrates and why |

**Round 5 is the one that matters.** Each `<h3>` already names its NFR
(`3 · The one link everybody clicks → NFR: latency; availability`), so the question
writes itself: *how does this design meet that NFR, and what did it reject on the way?*
A reader who can recall the mechanism but not the rejected alternative has learned the
answer and not the argument.


## 4. Flags

- `--blocks <list>` — grill only these blocks, one round each. Use after a first grill
  found the gaps.
- `--quick` — one round of 4 questions drawn from the whole page, no ladder.

## 5. The scorecard

The output, in this order:

- **Verdict** — the level the answers demonstrated, named from the page's own `levels`
  block: "Mid-level, reaching Senior on the read path". Never a percentage.
- **Held up** — what they got, one line each. Short; this section is not the point.
- **Gaps** — one line per miss: what was asked, what the page says, and the **stable
  id** it says it at (`bitly.md#deepdives-dive-3`). This is the section they re-read.
- **Rubric trace** — each unmet bullet from the `levels` block, quoted, with the round
  that showed it missing. A bullet nothing tested is marked untested, not passed.
- **Next** — the two or three ids to re-read, and an offer to re-grill on `--blocks`
  covering only those.

Every gap carries an id. A gap the reader cannot navigate to is a complaint.

Offer to mark the page practiced only after a grill with no gaps — the site's practiced
tracker means "worked through it", and this skill is the only thing that can honestly
tell.

## What this skill is not

- **Not [grill-me](../grill-me/SKILL.md).** That interrogates a proposal into
  requirements — the subject is a system that does not exist and the user is the
  authority. Here the page is the authority and the user is under test.
- **Not [kb-grill-page](../kb-grill-page/SKILL.md).** That grills a pattern, hazard,
  theme, principle, capability or comparison page. Same mechanic, different ladder.
- **Not [kb-design-review](../kb-design-review/SKILL.md).** That reviews the page and
  finds *its* faults. This one takes the page as correct and finds the reader's.
- **Not [kb-discuss](../kb-discuss/SKILL.md).** There the user asks the questions and you
  may teach. Here you ask them and must not.
- **Not a tutor.** Explaining is what the page does. If the reader wants to be taught, send them to the page and offer to grill afterwards.

## Done means

- No question quoted the answer, and no distractor was a straw man.
- Every round went through the question UI with ≤4 questions; the total stayed within
  6 rounds.
- Every block the page carries was covered, or its omission was the reader's choice
  via `--blocks` and is stated in the scorecard.
- Round 5 asked, for each dive, both the mechanism and what it rejected.
- The verdict is phrased in the page's own `levels` vocabulary, not as a score.
- Every gap cites a stable id that resolves, and no gap cites a block the grill never
  asked about.
- Nothing was taught mid-grill.
