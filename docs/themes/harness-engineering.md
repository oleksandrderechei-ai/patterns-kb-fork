---
title: Harness Engineering
description: Everything around the model is the part you own and can change
area: themes-shaping
owner: Oleksandr Derechei
tags: [machine-learning, isolation, validation]
status: stable
aliases: [agent harness, harness design, agent runtime]
---

# Harness Engineering

The model is a dependency you did not write and cannot change. Everything else — what it is shown, what it may do, how its work is checked, and what survives when the window fills — is yours, and the same model produces measurably different results depending on how you build it.

## The question
<!--meta block=description-->

Two teams run the same model on the same task and get very different results because an agent is a model plus a harness. This theme asks where to spend effort when the model is rented. Guides act before the model does and raise the first attempt; sensors act after and let it self-correct. Each runs as a cheap deterministic check or a costlier model judgment, and cheap checks cannot see that the agent solved the wrong problem.

## Explained
<!--meta block=explain-->

A harness is everything around a rented model that makes it do useful work: the instructions, tools and files you give it, plus the checks you run on what it produces. Spend effort in two directions. Guides act before the model does and raise the chance of a good first attempt. Sensors act after, such as the build, the tests or a reviewer, and let the agent correct itself. Checks come in two kinds. A deterministic check is cheap and repeatable, from milliseconds for a syntax check to seconds for a test run, and catches syntax errors and broken tests, but cannot see that the agent solved the wrong problem. A check that asks a second model to judge can see it, costs a model call each time, and gives an answer that can vary. A harness built only from cheap checks passes wrong-problem failures, so add a judging check where a wrong answer is costly. A harness pays back per repetition, so skip it for one-off tasks.

- **Human fatigue.** People approve without reading once prompts are constant, so prompt rarely and only on real risk.
- **Judge cost.** A judging check adds a model call and varying answers, so run it only where a wrong answer is costly.
- **Drift.** Old guides and sensors end up contradicting each other, so re-run the evaluation suite after every harness change and review them on a schedule.

**Example.** An agent fixes 100 issues a week across one codebase. A test run of 20 s per fix costs 2,000 s, about 33 minutes, and catches broken code. But 10 of the fixes pass the tests and solve the wrong problem. A judging check on all 100 costs 100 extra model calls, and how many of those 10 it flags is a rate to measure, not assume. Asking a human to approve every fix means 100 prompts, and in this example they stop reading by the 30th. Instead the agent is sandboxed to the repo directory and a human is asked only before a write outside it, assumed here to happen 3 times a week.

## The tradespace
<!--meta block=tradespace-->

The first axis is what a check costs against what it can see. Deterministic checks (computational sensors) are cheap and repeatable, from milliseconds for a syntax check to seconds for a test run, so they run every turn, and they cannot tell you the agent solved the wrong problem. Judging checks (inferential sensors) can, and cost a model call each with a verdict that is itself non-deterministic. A harness built only from deterministic checks passes the failures they were never going to catch.

The second axis is autonomy against confidence. Every control either asks a human or does not. Asking is trustworthy and slow, and it degrades: past a certain rate people approve without reading, so a harness that prompts constantly has less real review than one that prompts rarely and means it. Not asking requires the boundary and the acceptance check to be right, because nothing else is looking.

The third is investment against horizon. A harness costs engineering time and pays back per repetition, so a one-shot task never repays the build time and a job that runs weekly across a shared codebase repays it every run. Legacy code with weak tests most needs a harness and can least afford to build one.

The fourth is drift. Guides and sensors accumulate until two of them disagree, and nothing detects that except the agent behaving oddly. Treat the harness as a system with its own maintenance cost rather than as configuration you write once.

The fifth is what the agent retrieves from and what it connects to. [Retrieval-Augmented Generation](../patterns/ml/rag.md) puts passages from your own documents into the prompt, so answers carry a source and a corpus change is an ingestion job, at the price of the pipeline that keeps the index current. The [Agent Client Protocol](../patterns/distributed/routing/acp.md) lets one agent run in any editor that speaks it, instead of one plug-in per editor. The [Agent2Agent protocol](../patterns/distributed/coordination/a2a.md) hands a long job to another team's agent as a task with a lifecycle, so neither side sees the other's prompts or tools.

```mermaid caption="Two directions of control around one loop. Arrows 1 and 5 are where a recurring mistake gets fixed: it is a missing guide or a missing sensor, not a model problem. Arrows 6 and 7 carry work across a context window longer than one."
flowchart LR
    G["Guides — instructions, conventions, tool surface, what it may open"]
    L["The loop"]
    W["Workspace and tools"]
    S["Sensors — build, tests, review"]
    P[("Durable progress — files, commits, task list")]
    G -->|"1 shape the attempt"| L
    L -->|"2 action"| W
    W -->|"3 result"| L
    W -->|"4 artifact"| S
    S -->|"5 verdict"| L
    L -->|"6 write what must survive"| P
    P -->|"7 reseed the next window"| L
```

## The tour
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [AI Agent](../patterns/architecture/ai-agent.md) {#tour-ai-agent}

Start here, because everything else on this page is a decision about this loop. Reason, act, observe, repeat until a stop condition fires. The stop condition, the tool list and the transcript are all harness, not model. A turn cap and a token cap set in the runtime are stop conditions the model cannot skip.

### [Model Context Protocol](../patterns/distributed/routing/mcp.md) {#tour-mcp}

The guides half starts with what the agent may do at all. Publishing capability behind one contract makes the tool list a run-time decision you can vary per user and per workspace, and makes every connected server a trust boundary you choose deliberately.

### [Agent Client Protocol](../patterns/distributed/routing/acp.md) {#tour-acp}

The agent is a subprocess the editor starts and talks to over JSON-RPC, with a small surface: sessions, prompt turns, file access, terminal commands and permission requests. One contract replaces an integration per editor, and the mediated file and permission surface is where the sandbox boundary is drawn.

### [Agent2Agent](../patterns/distributed/coordination/a2a.md) {#tour-a2a}

The unit of delegation is a task with an identifier and a readable lifecycle, not a request. Both ends can send more messages against the task, so a long delegation can pause for input from the user and stay interactive.

### [Context Engineering](../patterns/ml/context-engineering.md) {#tour-context-engineering}

The other half of the guides: not what the agent may do, but what it can see while deciding. This is where a long session keeps its goal or loses it as early instructions leave the window.

### [Retrieval-Augmented Generation](../patterns/ml/rag.md) {#tour-rag}

An index over your documents is searched at request time and its passages go into the prompt, so every answer can cite its source and changing the corpus is an ingestion job rather than a training run. The index is a read model and inherits the staleness of one.

### [Agent Memory](../patterns/ml/agent-memory.md) {#tour-agent-memory}

Work that runs longer than one window needs continuity that is not the transcript. Distilled facts, a progress file and the commit history are the same move: durable artifacts the next session reads to reconstruct where it is.

### [Agent Sandboxing](../patterns/security/agent-sandboxing.md) {#tour-agent-sandboxing}

The permission half. Declaring the boundary once lets routine work proceed unasked, which keeps the prompts that remain few enough to be read rather than clicked through.

### [Evaluation](../patterns/ml/evaluation.md) {#tour-evaluation}

The sensors half, applied to the harness itself. A harness change alters a non-deterministic system, so a suite you can rerun is how you show whether it helped.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Signal | Reach for |
| --- | --- | --- |
| To bound what one run may spend before it is stopped | Cost per task climbing | [AI Agent](../patterns/architecture/ai-agent.md), with a turn and token budget in the runtime, never in the prompt |
| An assistant maintained as a separate plug-in for every editor | Every editor needs its own plug-in for the agent | [Agent Client Protocol](../patterns/distributed/routing/acp.md) |
| To vary what the agent can do per user or workspace | One tool list for everybody | [Model Context Protocol](../patterns/distributed/routing/mcp.md) |
| Quality to hold across a long session | Early instructions stop being honoured | [Context Engineering](../patterns/ml/context-engineering.md) |
| Answers that must come from your documents, with a source | Answers are invented and cite nothing | [Retrieval-Augmented Generation](../patterns/ml/rag.md) |
| A long job done by an agent another company runs, with questions halfway | The other team's agent is a black box | [Agent2Agent](../patterns/distributed/coordination/a2a.md) |
| Work to continue across a window boundary | Every session starts blank | [Agent Memory](../patterns/ml/agent-memory.md) |
| Autonomy without handing over the machine | Approval fatigue | [Agent Sandboxing](../patterns/security/agent-sandboxing.md) |
| To know whether a harness change helped | Only anecdotes, in both directions | [Evaluation](../patterns/ml/evaluation.md) |
| Deterministic, reproducible execution | The same steps run in the same order every time | [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md), instead of a loop |
| The number and order of steps to depend on what earlier steps find | Each result decides the next step | [AI Agent](../patterns/architecture/ai-agent.md) |

## Related areas
<!--meta block=siblings-->

- [Continuous Delivery](./continuous-delivery.md) — The sensors half is this discipline's feedback loop, pointed at a worker that is not deterministic.
- [Observability](./observability.md) — A run you cannot read afterwards is a run you cannot improve — the same argument, at the scale of one session.
- [GenAI Scale](./genai-scale.md) — What changes when the loop is not one developer's session but thousands of concurrent ones.
- [Auth and Access](./auth-and-access.md) — The permission question the sandbox answers locally, asked properly across services.
