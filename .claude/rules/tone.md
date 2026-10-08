---
description: "The house prose register for KB pages: nine rules, the format recipes and the cut-on-sight list, distilled from the AWS, Azure and Google Cloud architecture guides. Use when writing or reviewing page prose under docs/."
paths: ["docs/**/*.md"]
---

# House tone — the pattern-doc register

**Question:** how does a KB page's prose read?

> The canonical tone rulebook for Software Design Atlas prose. Skills and agents point here
> instead of restating these rules. Where a `kb-design-*` skill declares a
> block-specific exception, the exception wins — see [Scope](#scope).

Distilled from the three best pattern-documentation corpora:

- AWS Prescriptive Guidance, cloud design patterns —
  <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html>
- Azure Architecture Center —
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead>
- Google Cloud Architecture Framework —
  <https://docs.cloud.google.com/architecture/framework>

## The nine rules

One row per rule. An id is stable and never reused: a rule that stops applying is retired
with its id. A review note cites the row, as `tone.md#TONE-003`. No gate decides these nine
rules, so review does.

| ID | Rule | Decided by |
| --- | --- | --- |
| <a id="TONE-001"></a>TONE-001 | **Second person, active voice, imperative for advice.** Address the reader as "you"; headings and directives open with the verb. GCP: "Simplify your design and use fully managed services." | review |
| <a id="TONE-002"></a>TONE-002 | **One concept per sentence, 2–3 sentences per paragraph.** A sentence that needs "and which also" is two sentences. A paragraph past three sentences is hiding a second paragraph. | review |
| <a id="TONE-003"></a>TONE-003 | **Every claim carries its consequence.** State what happens, then what that costs or buys — in the same sentence or the next. AWS: "A failure in one of these operations might result in inconsistent data." Azure: "Isolate the elements of an application into pools so that if one element fails, the others continue to function." | review |
| <a id="TONE-004"></a>TONE-004 | **Open with the imperative essence.** The first sentence of any explanation is the verb-first summary plus its payoff — no scene-setting, no history. The Azure opener above is the whole pattern in one sentence; everything after it is elaboration. | review |
| <a id="TONE-005"></a>TONE-005 | **Phrase applicability as the reader's situation, not the pattern's features.** AWS: "Use the transactional outbox pattern when: You're building an event-driven application… You want to ensure atomicity… " and the honest inverse: "This pattern might not be suitable when…". Never "this pattern provides atomicity". | review |
| <a id="TONE-006"></a>TONE-006 | **Motivate with failure branches.** The reason a mechanism exists is what breaks without it, shown as its two (or three) branches: "If the database update succeeds but the event notification fails, the downstream service is unaware of the change. If the update fails but the event is sent, data is corrupted." | review |
| <a id="TONE-007"></a>TONE-007 | **Demonstrate incrementally: baseline → failure → fix.** Show the naive design, show exactly where it breaks, then apply the fix — one option at a time if there are several. Every diagram and code block answers exactly one question; a diagram that doesn't show a failure or a fix is decoration. | review |
| <a id="TONE-008"></a>TONE-008 | **No hedging stacks, no marketing adjectives.** One hedge is a confidence marker; "may possibly be somewhat" is three doing one job badly. "Robust", "scalable", "significant" are unpriced claims — replace with the figure or the mechanism. "Where feasible" is the acceptable softener for a directive that has real exceptions. | review |
| <a id="TONE-009"></a>TONE-009 | **Emphasis is bold. Never italic.** The corpus carries no italic, `*x*`, `_x_`, `<em>` or `<i>`, and nothing in any stylesheet renders it. Reach for `**bold**` when a run-in label opens a bullet, `` `code` `` when the word is an identifier, and nothing at all when the sentence already puts the word where the stress falls — which is the usual answer. A word italicised for contrast ("the totals are computed *before* anyone asks") is a sentence that has not been rewritten yet: move the word, or split the sentence. | review |

## Format recipes

**Consideration bullet** — bold label, then a directive plus its reason, one line:

> **Transaction rollback**: Do not send out an event notification if the transaction
> is rolled back.

> **Duplicate messages**: Make the consuming service idempotent by tracking processed
> messages, because the relay may deliver an event more than once.

**Applicability list** — "Use it when:" + the reader's situations, then the inverse:

> Use this pattern when:
> - You want to isolate critical consumers from standard consumers.
> - You need to protect the application from cascading failures.
>
> This pattern might not be suitable when:
> - The added complexity isn't necessary.

**Benefit bullet** — capability + consequence, never a bare adjective:

> - Isolates consumers from cascading failures. A problem in one bulkhead can't take
>   down the rest of the solution.

**Motivation pair** — the failure branches, each "If X but Y → consequence"
([TONE-006](#TONE-006)).

**Demonstration walk** — the incremental sequence ([TONE-007](#TONE-007)): baseline design
→ the failure it admits, shown concretely → fix option A → fix option B, each step with
the one diagram or snippet that proves it.

## Cut on sight

A word with one plain replacement is banned by machine. The
[glossary](../../docs/reference/glossary.md) lists each banned phrasing with the word to write,
and the vocabulary gate fails any markdown prose line that uses one. To ban a word, add it to the
`avoid` list of a `house`-scope term in [`docs/data/glossary.json`](../../docs/data/glossary.json),
whose `term` is the word to write instead, and run `make gen`. Never add it here.

The rest need a person to choose the replacement, so review cuts them:

| Cut | Use |
|---|---|
| it is worth noting that | nothing: delete it |
| significant / substantial | the actual figure |
| italic (`*x*`, `_x_`) | `**bold**` for a label, `` `code` `` for an identifier, or nothing |

Also cut: intros that restate the heading, transitions ("with that said"), summaries of
what you just wrote, adverb intensifiers, "note that".

## Scope

This file governs KB page prose and any pattern-doc writing in this repo. It is the
reference for humans and for agents working without a skill loaded.

**Skills are self-sufficient by design.** `style-simple`, `style-technical`,
`style-system-design`, `style-pattern-doc`, `kb-explain` and the `kb-design-*` block
skills each carry the register rules they need inline, so loading one is enough. They do
not link back here, and this file is not a dependency of theirs — when a rule changes,
update this file and the skills that state it.

Three block formats deliberately depart from the recipes above, and say so in their own
skills:

- **Tradeoffs limit items** are bold claim + fact. They state rather than argue, so
  "directive + reason" does not apply.
- **Levels rubric bullets** are verb-first third person — they describe a candidate's
  behaviour, not the reader's.
- **A design's problem-block answers** are **first** person plural — "we turn it away",
  not "you turn it away". The block is a conversation with a stakeholder, so the answer
  comes from the team that will build the thing. [TONE-004](#TONE-004) binds harder here
  than anywhere: the decision is the first word, one plain sentence of reason follows, and
  the balancing constructions [TONE-008](#TONE-008) tolerates elsewhere (*X rather than Y*,
  *not an A but a B*) are the block's characteristic failure. See `kb-design-problem`.

Skill frontmatter `description:` fields are routing triggers, not prose — this file
does not apply to them.
