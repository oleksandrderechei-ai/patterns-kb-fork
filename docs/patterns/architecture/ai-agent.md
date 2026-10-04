---
title: AI Agent
description: "A model in a loop with tools, running until the goal is met"
area: architecture
owner: Oleksandr Derechei
tags: [machine-learning, composition]
status: stable
aliases: [agent, agentic loop, tool-calling loop, LLM agent]
solves: ["the number of steps depends on what we find halfway through, so I cannot write the workflow", "our automation breaks the moment an error message, a schema or a page changes", "someone has to sit and babysit the script, answering one judgement call between every step", it says the job is done but nothing actually checked the result, each run costs more than the last and I cannot tell which part is spending it]
---

# AI Agent

Give a language model a set of tools and call it in a loop: it picks the next action, your runtime executes it, and the result becomes input to the next turn. You stop deciding the order of the steps and start deciding when the loop is allowed to stop.

## What it is
<!--meta block=description-->

Some work cannot be written as a fixed workflow, because the next step depends on what the last one found. An agent hands that order to a language model: your program supplies the tools, and the model picks one each turn or says the goal is met. Your runtime runs the call, adds the result, and asks again. You design what the model sees, what it may do, and how you know it finished.

## Explained
<!--meta block=explain-->

An AI agent is a loop. A language model sees everything that has happened so far, then either asks your program to run a tool or says the goal is met. Your program runs the tool, adds the result to the transcript, the running record of everything so far, and calls the model again, so your code supplies the tools and the model picks the order. Choose it over a fixed [workflow](../distributed/coordination/workflow-orchestration.md) only when the number and order of steps cannot be known in advance and the environment answers back, such as a compiler or a test run. Otherwise you pay for unpredictable runs and a transcript re-sent on every turn.

- **Cost outruns the work.** Each turn re-sends the whole transcript, so summarise old turns and keep bulky output in files.
- **Self-reported success.** End the loop only when an outside check passes, such as a green build.
- **Hostile tool results.** Limit what tools can do and keep irreversible actions behind a person.
- **Fading instructions.** Keep the goal in a file the model re-reads each turn.

**Example.** An agent fixes a failing build. It starts with 2,000 tokens of instructions and adds 1,500 tokens of tool output per turn, and every turn re-sends everything so far. After 10 turns the model has read 10 × 2,000 + 1,500 × (0 + 1 + … + 9) = 87,500 tokens, though only 15,000 were new. Writing test output to a file and keeping a 300-token summary per turn cuts that to 20,000 + 300 × 45 = 33,500. The loop stops only when \`make test\` exits 0, or at 15 turns, so a model that claims success early is sent back. The cost is that re-reading a file takes a turn of its own.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one goal become an unknown number of steps? The runtime owns the loop: it re-sends the growing transcript at step 2, executes whatever comes back at step 4, and is the only component that may decide the loop has ended. The model never touches the world directly. Everything it does passes through the tool surface you defined."
flowchart LR
    Caller["Caller"]
    subgraph Loop["The agent loop"]
        Runtime["Runtime"]
        Transcript[("Transcript")]
    end
    Model["Language model"]:::ext
    Tools["Tool surface"]
    World[("Files, services, network")]:::ext
    Caller -->|"1 goal"| Runtime
    Runtime -->|"2 transcript and tool schemas"| Model
    Model -->|"3 tool call or final answer"| Runtime
    Runtime -->|"4 invoke"| Tools
    Tools -->|"5 effect"| World
    Tools -->|"6 observation"| Transcript
    Runtime -->|"7 answer once the stop condition fires"| Caller
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="A turn can end three ways, and only one is progress. A refused call and a failed call both come back as ordinary observations, so the model can correct itself. An exhausted budget is the one branch the runtime decides, and may or may not tell the model about."
sequenceDiagram
    autonumber
    participant R as Runtime
    participant M as Model
    participant T as Tool
    R->>M: transcript and tool schemas
    loop until stop condition
        M-->>R: tool call
        alt budget exhausted
            R-->>R: stop, return partial work
        else guard refuses the call
            R->>M: refusal, as an observation
        else executed
            R->>T: invoke with model-supplied arguments
            T-->>R: result, or error text
            R->>M: enlarged transcript
        end
    end
    M-->>R: final answer, no tool call
```

## Variations
<!--meta block=variations-->

- **Single loop, flat tool list** — One model, one transcript, every tool visible at every turn. Cheapest to build and to reason about, and the right starting point. It stops working when the tool list grows past what the model chooses between reliably, or when the transcript outgrows the context window.
- **Plan then execute** — A first turn writes the step list as an artifact; later turns work against it and update it. Re-reading the plan each turn makes drift from the original goal visible instead of gradual. You pay one extra model call, and you inherit any plan that was wrong from the start.
- **Supervisor and workers** — One coordinating loop whose tools are other loops. Each child works in its own transcript and returns a summary, which bounds the parent's context growth and lets sub-goals run in parallel. The parent only ever sees the summary, so a child that quietly did the wrong thing still reports success. Total tokens usually rise, since each child repeats the instructions and tool output it needs.
- **[Retrieval](../ml/rag.md) as a tool** — Instead of a fixed retrieve-then-answer pipeline, retrieval becomes one more call the model makes when it notices a gap. It fetches more precisely and less often, but it can miss the gap, where a fixed pipeline always retrieves at the cost of an extra fetch when it was not needed.
- **Code as the only action** — Rather than a menu of tools, the model gets one: run this code. It composes behaviour you never anticipated, which is both the point and the risk. Only run this form inside a [sandbox](../security/agent-sandboxing.md).
- **Computer use** — The tools are a screenshot, a pointer and a keyboard, so the loop drives software that exposes no API at all. It reaches systems nothing else can reach, but each step costs a screenshot plus a model turn, and a misplaced click may not be recoverable.
- **Approval gate** — The runtime pauses on selected tool calls until a person approves. Safest for irreversible actions; it adds latency and rules out unattended runs.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Handles work whose step count** is unknown in advance, so you do not have to enumerate branches you have not met yet.
- **Corrects itself from real feedback.** When the environment answers, such as a compiler, a test run or an HTTP status, the next turn sees the failure and can act on it.
- **New capability arrives as a new tool**, not a new code path, so the routing logic does not change when the tool list does. This holds up to the point the model can choose among tools reliably; each tool still needs a description it can act on.
- **Absorbs the small judgement calls** that would otherwise interrupt a person once per step.
- **Degrades to partial progress** rather than a hard failure, provided every action it takes is recoverable.

### Cons
<!--meta polarity=con-->

- **Non-deterministic**. The same goal takes a different route on every run, so a bug reproduces only statistically and regression testing needs an evaluation suite rather than assertions.
- **Cost grows faster than the work does**, because every turn re-sends the whole transcript before it. A cache on the unchanged prefix lowers the price of the re-read but not the context length, so fading (con 5) still applies.
- **Reports success on its own authority**. Without an external check, "done" means the model stopped, not that the goal was met.
- **Tool results are untrusted input**. Every one lands in the same context as your instructions, so a hostile document or web page can redirect the loop.
- **Quality falls as the transcript lengthens**: instructions given early compete with accumulated tool output, so the model may follow them less as it fills.
- **The action surface is the blast radius**. Anything a tool can do, a misled loop can do, at machine speed and without hesitating.
- **Latency is a multi-turn sum** of model calls and tool calls, which puts an interactive budget of a few hundred milliseconds permanently out of reach.
- **Can loop without progress**. A model that retries the same failing call burns the whole budget, so the runtime needs repeat detection as well as a turn cap.
- **Per-step error compounds**. A step that is right 95% of the time succeeds on 20 steps only about 36% of the time, so long runs need checkpoints.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The number and order** of steps depend on what the earlier steps find.
- **The environment answers back**, so the loop has something real to correct itself against.
- **A person would otherwise** sit between the steps making routine calls that are obvious in context.
- **The task tolerates minutes rather than milliseconds**, and a partial result is still worth having.

### Avoid when
<!--meta polarity=avoid-->

- **The steps are known and fixed**. A [workflow](../distributed/coordination/workflow-orchestration.md) is cheaper, faster and reproducible, and the agent's cost buys nothing then.
- **A wrong action cannot be undone** and you are not willing to gate it behind a human.
- **The request has a hard** latency budget in the hundreds of milliseconds.
- **You cannot state a stop condition**. Without one, the loop runs until it exhausts a budget you never set.
- **Your only stop is the model saying it is done**. Use plan-then-execute with an external check, or a workflow.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the loop, its budget, the repeat check and the guard in front of every call"
type Tool = { name: string; schema: object; run(args: unknown): Promise<string> };

async function runAgent(goal: string, tools: Tool[], limits: { turns: number; tokens: number; toolMs: number }) {
  const transcript: Message[] = [{ role: "user", content: goal }];
  let spent = 0;
  let lastCall = "";

  for (let turn = 0; turn < limits.turns; turn++) {
    const reply = await model.complete({ messages: transcript, tools: tools.map(t => t.schema) });
    spent += reply.usage.total;
    transcript.push(reply.message);

    if (!reply.toolCall) return { status: "done", answer: reply.text, turns: turn, spent };
    // Checked after the call, so a run can overshoot the budget by one model call. Compaction is omitted.
    if (spent > limits.tokens) return { status: "budget-exhausted", transcript, turns: turn, spent };
    const callKey = reply.toolCall.name + JSON.stringify(reply.toolCall.args);
    if (callKey === lastCall) return { status: "stuck", transcript, turns: turn, spent };
    lastCall = callKey;

    const tool = tools.find(t => t.name === reply.toolCall.name);
    // A refusal is an observation, not an exception: the model has to see it to change course.
    const observation = !tool
      ? `no such tool: ${reply.toolCall.name}`
      : (await guard(tool, reply.toolCall.args))
        ? await Promise.race([tool.run(reply.toolCall.args), new Promise<string>((_, no) => setTimeout(() => no(new Error("timeout")), limits.toolMs))]).catch(e => `tool failed: ${e.message}`)
        : `refused: ${tool.name} is not permitted here`;

    transcript.push({ role: "tool", callId: reply.toolCall.id, content: observation });
  }
  return { status: "turn-limit", transcript, turns: limits.turns, spent };
}
```

## In the wild
<!--meta block=wild-->

- **LangGraph** — Models the loop as an explicit graph of nodes and edges with persisted state, so a run can be paused, inspected and resumed rather than only re-run. {#wild-langgraph}
- **Microsoft Agent Framework** — An open-source SDK for Python and .NET whose unit is an agent with a tool registry, plus an orchestrator for handing work between several of them. {#wild-agent-framework}
- **Pydantic AI** — Validates the model-supplied tool arguments against a declared schema before the call reaches your function, so a malformed call becomes an observation rather than an exception. {#wild-pydantic-ai}
- **smolagents** — The code-as-action form: the agent writes Python that calls the tools, instead of emitting one structured tool call per turn. {#wild-smolagents}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Turn limit** — The hard ceiling on iterations. Enforce it in the runtime, never in the prompt. A model asked to stop after ten turns may not, and nothing then ends the run. Set it just past the p95 of turns per completed task.
- **Token budget per run** — A second ceiling that catches the case a turn limit misses: few turns, each enormous. Set it just past the p95 of tokens per task for successful runs.
- **Per-tool timeout** — One slow tool otherwise holds the whole run open past any caller deadline. Work it out from the caller deadline divided by expected tool calls per run, and keep it below the runtime pool wait behind a timeout cascade.
- **Compaction threshold** — The fraction of the context window at which the transcript is summarised. Too low and you discard what the task needs; too high and the last turns have no room. Pin the goal and constraints outside the summarised span, and watch externally verified success as you move it.
- **Sub-agent fan-out** — How many child loops a supervisor may run at once. This multiplies spend, so cap it.
- **Model retry policy** — Attempts and backoff for provider errors, kept separate from the loop’s own turn count so a retried call is not counted as progress.
- **Sub-agent spawn depth** — Maximum levels of children, enforced in the runtime, with one spend cap shared across the whole tree.

### Signals to watch
<!--meta polarity=signal-->

- **Turns per completed task** — The distribution, not the mean. A long tail is the loop failing to converge rather than the work being hard.
- **Tokens per task** — Track alongside turns: the two diverge when the transcript is growing faster than the work.
- **Stop-reason mix** — Shares of final-answer, turn-limit, budget-exhausted and error. Turn-limit rising is the earliest sign of trouble.
- **Tool error rate, per tool** — One tool failing repeatedly usually means its description is wrong, not that its implementation is.
- **Externally verified success rate** — What a build, a test run or a reviewer says. It is the only success number that is not the model marking its own work.
- **Repeated identical calls per run** — The same call with the same arguments twice in a row is the loop stuck. Counting it needs only the logged calls.

### Failure modes under load
<!--meta polarity=failure-->

- **Stuck loop** — The model repeats one failing call until the turn limit, spending the whole budget on no progress. It shows first as a rising turn-limit share and a long turns-per-task tail; the repeated-call count names the cause.
- **Context exhaustion mid-task** — The transcript reaches the window and compaction drops the goal along with the noise. The loop keeps running and answers a different question.
- **Tool timeout cascade** — A dependency slows down, every turn now waits on it, and concurrent runs pile up until the runtime’s own pool is exhausted.
- **Rate-limit thrash** — Provider throttling turns each turn into a retry, so wall-clock time and cost both climb while the turn count barely moves.
- **Sub-agent explosion** — A supervisor spawns children that spawn children. Spend goes up by a factor nobody predicted, and no single run looks abnormal.
- **Injected redirection** — A tool returns text carrying instructions, the loop follows them, and the audit trail shows a well-formed run that did the wrong thing.

### Readiness checklist
<!--meta polarity=check-->

- Turn limit and token budget are enforced by the runtime, not requested in the prompt.
- Every tool is reversible, or gated behind a confirmation the loop cannot give itself.
- Any tool that executes code runs inside a filesystem and network boundary.
- Transcripts are persisted with their stop reason, so a bad run can be read afterwards.
- Completion is gated on an external check the loop cannot fake.
- An evaluation suite runs before any prompt, tool or model change ships.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — The loop the harness is built around {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Model Context Protocol](../distributed/routing/mcp.md) — Where the loop's tools come from when they are not hard-coded
- [Context Engineering](../ml/context-engineering.md) — What keeps the transcript from crowding out the work as turns accumulate
- [Agent Sandboxing](../security/agent-sandboxing.md) — The boundary that makes an execution tool safe to hand over
- [Retrieval-Augmented Generation](../ml/rag.md) — Retrieval demoted from a fixed pre-step to a call the loop makes when it notices a gap
- [Agent Memory](../ml/agent-memory.md) — What stops each session starting blank, facts the loop would otherwise rederive

**Alternative to**

- [Workflow Orchestration](../distributed/coordination/workflow-orchestration.md) — Pick the workflow when the steps are known; the loop only pays where they are not

**Enables**

- [Agent2Agent](../distributed/coordination/a2a.md) — Delegating a task to an agent built by someone else
- [Agent Client Protocol](../distributed/routing/acp.md) — How the agent reaches a human-facing host without a plug-in per editor

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Each cloud sells the hosting loop, so you write the tools and the instructions.

<!-- relationships:end -->
