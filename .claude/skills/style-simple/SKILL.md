---
name: style-simple
description: "Explain or rewrite anything in plain language for a smart adult outside the domain — plain and fast, never childish. Use when asked to \"explain simply\", \"in plain words\", \"make this easy to understand\" or \"what does this actually mean\". Not for a KB page (kb-improve) or engineers (style-technical)."
---

# Simple language for quick understanding

**Reader:** a smart adult outside this domain. They want to *get it* in under a minute,
not be taught a course. Plain is not childish — no toy stories, no "imagine you're a
pizza shop" unless the analogy genuinely shortens the path.

## The rules

- **Open with the verb and the payoff — "it does X so that Y".** Mechanism comes second.
  "A circuit breaker stops your service from calling a dependency that keeps failing, so
  one bad dependency can't drag everything down" — that's the whole opening. The
  *so that* half is not optional; without it you have described a behaviour and left the
  reader to guess why it matters.
- **One idea per sentence.** If a sentence has "and which also", split it.
- **Everyday words over jargon** — but when a domain term is unavoidable, keep it, name
  it once, and define it in the same sentence: "a dead-letter queue (a parking lot for
  messages that keep failing)". The reader may meet the term again; hiding it helps no one.
- **Concrete example before abstraction.** One real situation ("checkout calls the
  payment provider, the provider hangs") beats three paragraphs of general description.
- **Analogies only when structural.** The analogy must share the mechanism, not just the
  mood — and drop it the moment it stops matching. A stretched analogy costs more than
  no analogy.
- **Numbers stay, precision goes.** "About 100× slower" reads; "2.3ms vs 210µs p50" is
  for the technical version.
- **Emphasis is bold, never italic.** When this lands on a KB page, no `<em>` and no
  `<i>` — the corpus carries none and renders none. Plain words do the work; a word you
  want to lean on belongs where the sentence already leans.

## Write it

1. **Pull the raw material first**, when the thing to explain is a pattern from this KB:

   ```
   node scripts/kb.mjs get <id> --block usage       # when to use it, when not
   node scripts/kb.mjs find "<their words>"          # if they described a symptom, not a name
   ```

   The page's `essence` one-liner and `usage` block are the best starting points.
2. **Translate — don't quote.** KB prose is written for practitioners; your job is the
   plain-words version of it. Keep the facts, replace the vocabulary, applying the rules
   above one idea at a time.
3. **Fit it on one screen.** Cut anything the reader doesn't need to understand or act. If they want depth, they'll ask — or you point them to the technical version
   (`style-technical`).

## Done means

- A smart non-specialist gets the point from the first two sentences.
- Every remaining domain term is defined where it first appears.
- No analogy has outstayed its match.
- The explanation fits on one screen.
