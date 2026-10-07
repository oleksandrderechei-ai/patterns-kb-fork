---
title: Context Engineering
description: Treat the model's input window as a budget and decide what occupies it
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, resource-management, read-optimization]
status: stable
aliases: [context management, window budgeting, prompt context design]
solves: [the answers get worse the longer the session runs even though nothing else changed, our codebase is far bigger than anything that fits in one prompt, one tool prints ten thousand lines and it is re-sent on every turn afterwards, cost per task keeps climbing while the amount of work per task does not, the assistant followed my instruction at the start and then quietly stopped following it]
---

# Context Engineering

Treats the model's input window as a scarce, contended resource with a budget rather than a container you fill: material is fetched when a step needs it, bulky output is kept outside and referenced, and the transcript is compacted before it crowds out the work.

## What it is
<!--meta block=description-->

Giving a model everything it might need, such as whole files and whole tool outputs, hurts quality long before the window is full: early instructions get buried in noise. This pattern treats the window as a budget. The agent fetches what each step needs, keeps bulky output outside with a reference, and compacts when pressure rises. You trade recall for signal, so it pays only when the material exceeds what fits.

## Explained
<!--meta block=explain-->

Context engineering treats a model's window as a budget and decides, for each piece of material, whether it is loaded now, fetched when needed or left out. Without it, you paste in whole files and whole tool outputs, and quality falls well before the window is full, because early instructions get buried and irrelevant text competes for attention. You give the agent an index and a read tool, move bulky output to disk and leave a short stub, and summarise old turns when the window passes a set fraction. Choose it over simply buying a larger window when the material you need is many times the window size, or sessions run long enough that early instructions stop being followed.

- **Lossy cuts** Every cut loses something you cannot see, so keep full output on disk and re-attach durable instructions after any summary.
- **Extra round trips** Each fetch adds a turn, so preload only what every step needs.
- **Stale index** An index goes stale as code moves, so rebuild it on change.
- **Over-pruning** Pruning too hard forces re-fetching, so track how often the agent re-reads what you cut.

**Example.** An agent has a 200,000-token window and runs a test suite eight times in one task. Each run prints 30,000 tokens, so eight runs hold 240,000 and overflow the window. With offloading, each run writes its full output to disk and returns the first 40 lines plus a file path, about 600 tokens, so eight runs cost 4,800 tokens. The cost shows up on run 5: the failing test sat in the cut part, so the agent spends one extra turn and 2,000 tokens reading that section of the file.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a corpus far larger than the window get used? Nothing is pre-loaded. The index answers with pointers at step 2, the window pulls only what was named at step 3, and anything bulky the work produces goes straight back out at step 5 — so the window holds references rather than contents."
flowchart LR
    Step["Current step"]
    Index["Index or search"]
    Window["Context window"]
    Corpus[("Corpus, files, tool output")]
    Compact["Compaction"]
    Step -->|"1 what is missing?"| Index
    Index -->|"2 pointers, not contents"| Window
    Window -->|"3 read only what was named"| Corpus
    Corpus -->|"4 just that material"| Window
    Window -->|"5 large output written out"| Corpus
    Window -->|"6 pressure"| Compact
    Compact -->|"7 state and goal restated"| Window
```

```mermaid caption="Two independent pressure valves. Offloading is lossless — the material is still on disk and can be re-read — while compaction is not, which is why the durable instructions are re-attached explicitly afterwards rather than trusted to survive the summary."
sequenceDiagram
    autonumber
    participant R as Runtime
    participant M as Model
    participant F as Filesystem
    M-->>R: tool call
    R->>F: execute
    F-->>R: result
    alt result is large
        R->>F: write result to a path
        R->>M: a reference plus the first lines
    else result is small
        R->>M: the result itself
    end
    alt window above the compaction threshold
        R->>M: summarise state and remaining goal
        M-->>R: summary
        R->>R: replace transcript with summary, re-attach durable instructions
    end
```

## Variations
<!--meta block=variations-->

- **Retrieval on demand** — Nothing is pre-loaded; the agent calls a search tool whenever it notices a gap. Cheapest to build, and it fails silently when the model does not notice the gap.
- **Pre-indexed graph** — A persistent structural index of the corpus, queried for exactly the relevant nodes rather than searched. It turns "read the repository" into "read these four files", and it must be rebuilt as the corpus moves or it will point at code that is no longer there.
- **Compaction** — Periodic lossy summarisation of the transcript in place. The only move that reclaims space already spent, and the only one that can silently discard the goal along with the noise.
- **Offload and reference** — Large tool output is written to a file and the transcript keeps a handle — the [claim check](../messaging/claim-check.md) applied to a context window. Lossless, since the material can be re-read, at the price of an extra call when it is needed again.
- **Sub-agent isolation** — A child loop reads the bulky material in its own window and returns only a conclusion, so the parent's window stays clean. The child's token spend is moved, not saved, and the parent cannot check a conclusion it never saw the evidence for.
- **Scoped multi-repository workspace** — An explicit registry naming the repositories and their boundaries, so work that crosses two of them loads two rather than all of them. It is the same discipline as a [configuration store](../distributed/coordination/external-configuration-store.md): the scope is declared data, not something inferred at run time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Makes a corpus orders of magnitude larger** than the window workable at all.
- **Can raise answer quality before the window fills**, when irrelevant material was crowding out instructions. Check it against task success, since token counts alone do not show it.
- **Cuts cost directly**: every turn re-sends the window, so a smaller window is cheaper on every remaining turn. The net saving is the tokens not re-sent minus the extra fetch turns.
- **Lets a session outlive** the window, which is what makes long-running work possible.
- **Makes what the model is working from inspectable** — you can look at what was loaded and why.

### Cons
<!--meta polarity=con-->

- **Compaction and summaries are lossy**: they and terse encodings discard something, and the model cannot tell what is missing. Offloading loses nothing only while the file survives and the agent knows to re-read it.
- **Lazy loading costs turns**: each fetch is another round trip, so latency rises as window pressure falls.
- **Indexes go stale against a moving codebase**, and a stale index is confidently wrong rather than usefully empty.
- **Aggressive pruning causes re-fetching**, which costs more than keeping the material would have.
- **Sub-agent isolation protects the parent window** and hides the detail the parent might have needed.
- **A rich index is infrastructure**: built, refreshed and paid for, per repository, forever.
- **The benefit is hard to measure**. Token counts are easy and task success is what matters, and the two do not move together.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The material relevant to the task** exceeds the window by an order of magnitude.
- **Sessions run long enough** that early instructions visibly stop being honoured.
- **The same bulky tool output** is produced repeatedly and re-sent on every turn.
- **Cost per task is rising faster** than the work per task.

### Avoid when
<!--meta polarity=avoid-->

- **The repository is small enough** for the agent to simply read. An index buys nothing and can be wrong.
- **The session is short** — a summary loses more than the tokens it saves.
- **The task needs every detail** simultaneously, since every technique here works by withholding something.
- **You have no way** to tell whether task success changed, because then you are tuning a number that is not the goal.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — offload the bulky results, compact under pressure, re-attach what must survive"
const OFFLOAD_OVER = 4_000;          // tokens; below this, inlining is cheaper than a re-read
const COMPACT_AT   = 0.75;           // fraction of the window

// Lossless: the material stays on disk, so a later turn can read the part it actually needs.
async function observe(result: string, scratch: Scratch) {
  if (estimate(result) < OFFLOAD_OVER) return result;
  const path = await scratch.write(result);
  return `${head(result, 40)}\n… truncated. Full output at ${path} — read it if you need more.`;
}

// Lossy: everything not in the summary is gone, so the durable parts are re-attached by hand.
async function maybeCompact(transcript: Message[], durable: Message[], windowSize: number) {
  if (estimate(transcript) < COMPACT_AT * windowSize) return transcript;

  const summary = await model.complete({
    messages: [...transcript, { role: "user", content:
      "State what is done, what remains, and the constraints still in force. Facts only." }],
  });
  return [...durable, { role: "user", content: summary.text }];
}

```

## In the wild
<!--meta block=wild-->

- **Pre-indexed code graphs** — Tools that index a repository into a persistent structural graph so an agent answers a structural question from the index rather than by reading files. {#wild-codegraph}
- **Output-reducing command proxies** — A proxy in front of common developer commands that shrinks their verbose output before it reaches the model, cutting tokens on the calls made most often. {#wild-rtk}
- **Multi-repository workspace registries** — An explicit record of which repositories exist and where their boundaries are, so cross-boundary work loads two of them rather than all of them. {#wild-repo-registry}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Compaction threshold** — The fraction of the window at which the transcript is summarised. Too low discards what the task still needs; too high leaves no room for the turns that follow. The sketch starts at 0.75, a starting point and not a measured default: lower it if the goal gets lost, raise it if the re-read rate climbs.
- **Offload size threshold** — The output size above which a result is written to disk and referenced. Below it, inlining is cheaper than the later re-read. The sketch starts at 4,000 tokens, a starting point and not a measured default; tune it against the re-read rate.
- **Retrieval count and reranking depth** — How many candidates are fetched and how hard they are re-scored. More recall, less room, lower average relevance.
- **Index refresh trigger** — On commit, on a timer, or on demand. It sets how wrong the index is allowed to be.
- **Durable instruction set** — What is re-attached after every compaction. Anything not on this list does not survive a summary.

### Signals to watch
<!--meta polarity=signal-->

- **Window occupancy by part** — Instructions, retrieved material, transcript and tool output as shares. It shows which part is actually crowding out the work.
- **Compactions per session** — Frequent compaction often means the offload threshold is too high. Check window occupancy by part before raising the threshold or the window.
- **Re-read rate** — How often the same file or offloaded result is fetched again. High means pruning is too aggressive and is costing more than it saves.
- **Index staleness** — Age of the index against the last change to the corpus. This is the number that predicts confidently wrong pointers.
- **Task success against tokens per task** — Track both. Tokens falling while success falls is not an improvement, and only the pair shows it.

### Failure modes under load
<!--meta polarity=failure-->

- **Goal lost in compaction** — The summary keeps the recent detail and drops the objective. The session continues fluently and answers a different question.
- **Confidently stale index** — The index points at code that has moved. The agent reads nothing useful and concludes the code does not exist.
- **Thrash** — Pruning and re-fetching the same material in a loop, so token spend rises while progress stops.
- **Silent truncation** — Material is dropped to fit and nothing records that it was, so a wrong answer has no visible cause.
- **Isolation blindness** — A sub-agent read the detail and returned a conclusion, and the parent had no way to notice the conclusion was wrong.

### Readiness checklist
<!--meta polarity=check-->

- Durable instructions are re-attached explicitly after every compaction, not trusted to survive it.
- Offloading is preferred to compaction wherever the material can be re-read.
- Anything dropped to fit the window is logged, so a bad answer has a traceable cause.
- The index records its own age, and the agent is told when it is stale.
- Token metrics are read alongside a task-success measure, never on their own.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — What enters the window, and what leaves it {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [AI Agent](../architecture/ai-agent.md) — The window pressure it manages is created by the loop re-sending everything each turn
- [Claim Check](../messaging/claim-check.md) — Offloading bulky tool output and keeping a reference is this pattern, applied to a context window
- [Retrieval-Augmented Generation](./rag.md) — Index-and-fetch over a codebase, so only the named material is read
- [External Configuration Store](../distributed/coordination/external-configuration-store.md) — A multi-repository scope registry is declared data, like a config store, not inferred at run time.

**Often confused with**

- [Agent Memory](./agent-memory.md) — This decides what is loaded now; that decides what was worth keeping at all

<!-- relationships:end -->
