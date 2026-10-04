---
title: Agent Memory
description: "Keep what was learned, not what was said, so the next session starts informed"
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, state-management, data-access]
status: stable
aliases: [long-term memory, cross-session memory, persistent context]
solves: [I explain the same thing about this project at the start of every session, a correction I gave yesterday has been forgotten and the same mistake is back, the assistant retries a fix that was already tried and did not work, the transcript is too long to keep and too useful to throw away, facts learned for one customer are showing up in another customer session]
---

# Agent Memory

Splits what an agent said from what it learned: the transcript is discarded at the end of a session, and a small set of distilled, scoped facts is written to a store the next session reads — so the same ground is not re-established every time.

## What it is
<!--meta block=description-->

An [agent](../architecture/ai-agent.md) forgets everything when a session ends, so each new session relearns the repository and the person supervising explains it again. Keeping the whole transcript is long, mostly noise and too big to fit. Instead the agent writes the few facts worth keeping into a store the next session reads. The write policy and the scope decide whether that store stays useful.

## Explained
<!--meta block=explain-->

Agent memory is a small store of facts that an [agent](../architecture/ai-agent.md) writes down on purpose during a session and reads back at the start of the next, so the next session begins informed instead of blank. It keeps what was learned, such as which test runner this repository uses, and drops the transcript, which is long and mostly noise. Choose it over replaying the whole transcript when the same person and agent return to the same work and re-explaining costs a visible share of every session. Skip it for one-shot tasks and for anything the repository or database already states.

- **Window space** Recalled facts use room the work needs, so set a token budget and load a subset.
- **Stale facts** A replaced fact sounds as sure as a current one, so check new facts against close matches and retire the old entry.
- **Leaky scope** Mixed scopes show one customer's facts in another's session, so key every entry to a user or project.
- **Durable bad entries** A bad entry is re-read every session, so treat writes as untrusted input and keep the store readable.

**Example.** A coding agent works on one repository for 20 sessions. Each starts with 10 minutes of explaining that tests run with pytest. After session 1 it stores 12 facts of about 25 tokens each, 300 tokens, under a 500-token budget, so session 2 loads all 12 and skips the explaining. In session 9 the team moves to tox. The write check finds the pytest fact as a close match and retires it, so the store stays at 12 facts. Without retirement it would hold 13, two of them naming different runners. The cost is 300 tokens of every session's window, 0.3% of a 100,000-token window.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does a fact enter, and where does it leave? Step 2 is the only way in, which is what keeps the store small enough to be useful. Step 4 is deliberately a subset rather than the whole store — everything recalled is spent from the same context budget the actual work needs."
flowchart LR
    S1["Session N"]
    Policy["Write policy"]
    Store[("Memory store, scoped")]
    S2["Session N+1"]
    S1 -->|"1 what is worth keeping?"| Policy
    Policy -->|"2 insert, supersede or drop"| Store
    S2 -->|"3 load this scope at start"| Store
    Store -->|"4 the relevant subset"| S2
    S2 -->|"5 query on a gap mid-session"| Store
    S2 -->|"6 its own write on the way out"| Policy
```

```mermaid caption="Supersession is the branch that matters. Without it a store accumulates two contradictory facts and returns both with equal confidence, which is worse than having neither — hence the last step: a recalled fact is a hint to check, not an authority."
sequenceDiagram
    autonumber
    participant A as Agent
    participant P as Write policy
    participant M as Memory store
    A->>P: candidate fact at end of session
    alt contradicts a stored fact
        P->>M: supersede the old entry
    else already known
        P-->>A: drop, nothing to write
    else new and durable
        P->>M: insert, scoped and timestamped
    end
    Note over A,M: next session
    A->>M: load scope
    M-->>A: entries within the budget, newest first
    A->>M: query on a specific gap
    M-->>A: matches, which may be stale
    A->>A: verify against the source before acting
```

## Variations
<!--meta block=variations-->

- **Instruction file** — A small human-readable file loaded at the start of every session, which the agent itself edits as it learns. Cheap, reviewable and diffable, and bounded by the context window — which is also its limit, since it cannot grow past what you are willing to load every time.
- **Episodic log** — A compressed record per session — what was attempted, what worked — replayed selectively rather than in full. It answers "have we tried this before", which the instruction file cannot, and it grows without bound unless something prunes it.
- **Semantic store** — Facts distilled and indexed by [embedding](./embeddings.md), fetched by relevance at the moment of need. This is the form that scales past the window, and it returns what reads alike rather than what is true, so precision falls as the store grows.
- **Knowledge graph** — Entities and typed relations, queried rather than searched, so a multi-hop question is answerable at all. It buys real recall and costs a schema plus an extraction step that has to keep working as the domain moves.
- **Shared cross-client store** — One store that several different agent applications read, so a fact learned in one tool is not trapped there. The scoping and permission questions get much harder the moment two tools with different trust levels share a store.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Removes the re-explanation turn at the start** of every session, which on long-running work is a measurable fraction of each one.
- **Lets a correction stick**. Tell it once that this is the wrong test runner and the next session already knows.
- **Keeps the carried state small** and reviewable, unlike a transcript nobody will read.
- **Survives a context-window boundary**, so work can be split into sessions deliberately rather than by accident.
- **Makes what the agent believes inspectable** — you can read the store and delete a wrong entry.

### Cons
<!--meta polarity=con-->

- **Everything recalled costs window space**, so a memory loaded indiscriminately improves recall and degrades reasoning at the same time.
- **Stale memory is worse than none**: a superseded fact is asserted with exactly the confidence of a current one.
- **The write step is itself** a model call, so it distils badly sometimes, and nothing signals when it has.
- **Similarity retrieval returns what reads alike rather** than what is true, and precision falls as the store grows.
- **A memory store is a durable injection surface** — anything written once is re-read into context every session afterwards.
- **Per-user memory is personal data**, with the retention, export and deletion obligations that follow.
- **A graph store buys multi-hop recall** and charges for a schema and an extraction pipeline you now maintain.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The same person and the same agent** work together repeatedly on a long-lived body of work.
- **Re-establishing context costs a measurable share** of every session.
- **A correction given once keeps having** to be given again.
- **Work is deliberately split** across sessions, so continuity has to survive the boundary.

### Avoid when
<!--meta polarity=avoid-->

- **The task is one-shot**. There is nothing to carry forward and the write step is pure overhead.
- **The answer already lives in the repository** or the database. Read the source of truth; do not remember a copy of it.
- **You cannot say what supersedes** what, because the store will fill with contradictions.
- **The user has not agreed** to anything being kept.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the write policy, which is the part that decides whether this works"
type Memory = {
  id: string;
  scope: { user?: string; project?: string };   // never load across scopes
  fact: string;                                 // one claim, not a paragraph
  source: string;                               // where it came from, so it can be re-checked
  writtenAt: string;
};

async function remember(candidate: string, scope: Memory["scope"], store: Store) {
  // Cheap rejections first — most candidates are restatements of something already held.
  const near = await store.search(candidate, scope, { limit: 5 });
  const verdict = await model.classify({ candidate, existing: near });

  switch (verdict.kind) {
    case "duplicate":  return;                                   // say nothing twice
    case "supersedes": await store.retire(verdict.replaces);     // the old entry stops being returned
                       break;
    case "novel":      break;
    case "ephemeral":  return;                                   // true today, useless next week
  }
  await store.insert({ ...candidate, scope, writtenAt: new Date().toISOString() });
}

// Recall is budgeted, not exhaustive: the window is shared with the actual work.
async function recall(scope: Memory["scope"], store: Store, tokenBudget: number) {
  const entries = await store.load(scope, { newestFirst: true });
  return takeWhileUnder(entries, tokenBudget);
}

```

## In the wild
<!--meta block=wild-->

- **Mem0** — An open-source memory layer that sits between the agent and a store, deciding what to write and returning a scoped subset on recall. {#wild-mem0}
- **Cognee** — Persists agent memory as a knowledge graph rather than as text, so recall can follow a relation instead of relying on similarity. {#wild-cognee}
- **Instruction-file conventions** — Plain files loaded into context at agent startup and edited by the agent as it learns — the simplest form that works, and reviewable in version control. {#wild-agents-md}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Recall budget** — Tokens the store may occupy at session start. Everything it takes is taken from the work, so this is a real ceiling, not a default.
- **Scope key** — User, project, workspace or a combination. Getting this wrong is how one customer’s facts appear in another customer’s session.
- **Write threshold** — How confident the distilling step must be before a fact is kept. Low thresholds fill the store with restatements.
- **Retention and decay** — How long an unreferenced entry survives. Without one the store only grows, and precision falls with it.
- **Retrieval count** — How many entries a mid-session query returns. More recall, less room, and lower average relevance.

### Signals to watch
<!--meta polarity=signal-->

- **Store size and growth rate** — Entries per week against entries retired per week. If the second is near zero the write policy has no supersession.
- **Recall hit rate** — How often a loaded entry is actually referenced in the session. Low means you are paying window space for nothing.
- **Contradiction count** — Entries in the same scope asserting incompatible facts. It should be zero and it never is.
- **Entry age at use** — How old the facts being relied on are. Old and heavily used is either your best content or your most dangerous.
- **Manual deletions** — How often a human removes an entry. A rise is the write policy degrading, and it is the only signal that catches it early.

### Failure modes under load
<!--meta polarity=failure-->

- **Stale assertion** — A fact that was true is now wrong, and it is recalled with full confidence. The agent is wrong in a way that reads as certainty.
- **Store bloat** — Every session writes and nothing retires, until recall returns mostly noise and the budget is spent before the work starts.
- **Scope leak** — An entry written under one scope is loaded under another, putting one user’s or project’s facts into another’s session.
- **Bad distillation** — The write step misreads what happened and stores a wrong fact. Nothing signals it, and it is re-read every session afterwards.
- **Memory as an injection channel** — Content that reached the store once is re-injected into every later session, which makes a single bad write persistent.

### Readiness checklist
<!--meta polarity=check-->

- Every entry carries a scope and a timestamp, and recall never crosses scopes.
- The write policy can supersede and retire, not only insert.
- Recall is budgeted against the window rather than loading the whole store.
- Entries are short and human-readable, so a wrong one can be found and deleted.
- A recalled fact is verified against the source before it drives an irreversible action.
- Per-user memory has a stated retention period and a working deletion path.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — What survives the session boundary {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Embeddings](./embeddings.md) — What makes the semantic-store form retrievable once it outgrows a loadable file
- [AI Agent](../architecture/ai-agent.md) — What stops each session starting blank

**Often confused with**

- [Context Engineering](./context-engineering.md) — This decides what survives the session; that decides what enters this one

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — The agent platforms sell memory as a service: they extract, store and retrieve it per user.

<!-- relationships:end -->
