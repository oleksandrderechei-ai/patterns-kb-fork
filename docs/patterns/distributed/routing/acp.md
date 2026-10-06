---
title: Agent Client Protocol
description: One contract between a coding agent and whatever application hosts it
area: distributed-routing
owner: Oleksandr Derechei
tags: [integration, decoupling, boundaries]
status: stable
aliases: [ACP, Agent Client Protocol]
solves: [we maintain the same coding assistant as three separate editor plug-ins, our editor can only offer the one assistant we integrated first, the assistant writes files directly and does not see the edits I have not saved yet, developers want to change assistant without changing editor and cannot]
---

# Agent Client Protocol

Separates a coding agent from the editor that runs it, by standardising the small surface an agent actually needs from a host — a session, a prompt turn, file access, a terminal, and a way to ask a human for permission.

## What it is
<!--meta block=description-->

An agent that edits code needs a plug-in for each editor, and each plug-in drifts while editor authors back only the first agent they integrated. The agent client protocol defines a small set of messages between an editor and an agent it starts as a subprocess. One agent then runs in any editor that speaks it, and permission requests go to the editor, where the person is.

## Explained
<!--meta block=explain-->

The agent client protocol is a small set of agreed messages between a code editor and a coding agent that the editor starts as a subprocess, so one agent runs in any editor that speaks it. The messages cover starting a session, running a prompt turn, reading and writing files, running a terminal command and asking permission. File access and permission requests go back to the editor, so the editor's view of unsaved text stays authoritative and the component with a person in front of it decides. Choose it over a plug-in per editor when the agent must run in several editors and the integrations are already diverging. To give an agent tools and data, use a tool protocol such as [MCP](mcp.md) instead.

- **Extra round trips.** Every file operation goes through the editor, so batch reads where it allows and cache within a turn.
- **Lowest common denominator.** Keep a native extension for what only one editor can do.
- **Young protocol.** Few implementations exist, so keep the agent core independent and the protocol an adapter.

**Example.** A coding agent must support 3 editors. As plug-ins that is 3 codebases; over the protocol it is 1 agent. You edit app.ts but have not saved. The agent asks the editor to read app.ts and receives your unsaved text, so its edit applies to what you see, where a read from disk would have overwritten your change. It then asks permission to run npm test, and the editor shows you a prompt. The cost shows on large turns: reading 30 files at an assumed 5 ms a round trip is 150 ms; reading 10 files instead, or caching within a turn, cuts that to 50 ms.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does every arrow go through the editor? Because the editor is the component with a human in front of it. The agent never reads a file, applies a change or runs a command directly, so the host keeps its unsaved buffers authoritative and stays the only place a permission decision is made."
flowchart LR
    Dev["Developer"]
    Editor["Host application, the client"]
    Agent["Agent subprocess"]
    Files[("Workspace")]
    Term["Terminal"]
    Dev -->|"1 prompt"| Editor
    Editor -->|"2 prompt turn over stdio"| Agent
    Agent -->|"3 read this file"| Editor
    Editor -->|"4 buffer contents"| Agent
    Agent -->|"5 proposed change, as a diff"| Editor
    Editor -->|"6 may I?"| Dev
    Dev -->|"7 approve"| Editor
    Editor -->|"8 apply"| Files
    Editor -->|"9 run and stream output"| Term
```

```mermaid caption="Capability negotiation first, so neither side assumes a feature the other lacks. A refusal returns as an ordinary result rather than an error, which is what lets the agent revise its approach instead of aborting the turn."
sequenceDiagram
    autonumber
    participant E as Editor
    participant A as Agent
    E->>A: initialize — protocol version, what this host supports
    A-->>E: what the agent supports
    E->>A: new session for this workspace
    E->>A: prompt
    loop the turn
        A-->>E: streamed content, in markdown
        alt needs a file
            A->>E: read request
            E-->>A: contents, including unsaved edits
        else wants to change something
            A->>E: permission request with the diff
            alt approved
                E-->>A: granted
            else declined
                E-->>A: refused, with a reason
            end
        end
    end
    A-->>E: turn complete
```

## Variations
<!--meta block=variations-->

- **Editor-hosted subprocess** — The baseline and the only fully specified form: the editor starts the agent, owns its lifetime, and talks to it over standard input and output. No network, no ports, no authentication problem, but one agent cannot be shared between two windows.
- **Non-editor host** — Any application with a document surface can implement the client role, which is how a notes application or a review tool ends up running the same coding agents an integrated development environment (IDE) does. The agent needs no change at all; the host supplies the same small surface.
- **Remote agent** — The agent runs elsewhere and the transport becomes a network connection. Stated by the protocol as work in progress, so treat it as a direction rather than a choice you can make today.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **One integration per side** instead of one per pair: the agent author stops shipping a plug-in per editor, and the editor stops blessing one agent.
- **The host keeps authority** over file writes and permission decisions, which is exactly where the human is.
- **Developers can change agent without changing editor**, and the reverse, so neither choice locks in the other.
- **Markdown as the content format** means any host can render a turn without agreeing on a rich-text model.
- **Reusing the tool protocol's representations** where they fit keeps the two ecosystems compatible rather than parallel.

### Cons
<!--meta polarity=con-->

- **Conformance says nothing about quality**. A conforming agent can be a poor one, and the protocol gives a host no way to tell.
- **Reusing another protocol's types couples the two**: a change there becomes a change here.
- **A subprocess over standard input** and output ties the agent's lifetime to one window, so sharing one agent across clients is a non-goal rather than a missing feature.
- **A lowest-common-denominator surface gives up** editor-specific affordances that a native plug-in could use.
- **Mediating every file read** and write through the client adds a round trip to operations an agent performs many times per turn; the example sizes it at 150 ms for 30 reads.
- **A young protocol** with few implementations so far, so ecosystem risk is real. Keep the agent core independent and the protocol an adapter.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An agent should run** in more than one host application and the per-host integrations are already diverging.
- **The host must stay the authority** over what is written and what is permitted.
- **You are building the host** and want to offer a choice of agents without endorsing one.

### Avoid when
<!--meta polarity=avoid-->

- **Need is tools and data for an agent.** That is the [tool protocol](./mcp.md), which this one reuses rather than replaces.
- **The two parties are peer** agents, not a host and an assistant. Delegation between peers is [Agent2Agent](../coordination/a2a.md).
- **One editor is the only target** and its own extension API already does everything you need.
- **The interaction is not human-facing**, since the permission model assumes someone is there to answer.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — the host side: negotiate, prompt, and own every decision"
// The host starts the agent and speaks JSON-RPC over its stdio. No ports, no auth.
const agent = spawn(agentCommand, { stdio: ["pipe", "pipe", "inherit"] });
const rpc = jsonRpcOver(agent.stdin, agent.stdout);

// Negotiate first: neither side may assume a capability the other lacks.
const theirs = await rpc.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
});

const { sessionId } = await rpc.request("session/new", { cwd: workspaceRoot });

// The agent asks the host for everything. These handlers are where the host keeps authority.
rpc.handle("fs/read_text_file", ({ path }) => editor.bufferOrDisk(path));   // unsaved edits included
rpc.handle("session/request_permission", async ({ toolCall }) => {
  const choice = await editor.askUser(toolCall);  // a human picks an option, not the agent
  return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };  // a decline is a selected reject option; cancelled means the turn was cancelled
});

await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: userInput }] });

```

## In the wild
<!--meta block=wild-->

- **The ACP reference implementation** — The protocol project publishes the specification and a reference library for both the client and the agent role. {#wild-acp-reference}
- **JetBrains AI Assistant** — Documents support for the protocol as the way to host third-party coding agents inside the IDE. {#wild-jetbrains-acp}
- **Obsidian agent client** — A non-editor host implementing the client role, which is the case that shows the protocol is not IDE-specific. {#wild-obsidian-agent-client}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Declared client capabilities** — Which of filesystem read, filesystem write and terminal the host offers. It is the ceiling on what any agent can do in this host.
- **Permission policy** — Which proposed actions are auto-approved and which always ask. This is where approval fatigue is either created or avoided.
- **Agent process lifetime** — Whether the subprocess is per window, per session or per prompt. It decides how much state survives and how much memory is held.
- **Session working directory** — The root the session is scoped to, which is the coarse boundary before any finer permission check.

### Signals to watch
<!--meta polarity=signal-->

- **Permission prompts per turn** — The measure of whether the policy is usable. A high number means people will start approving without reading.
- **Filesystem round trips per turn** — Every read goes through the client, so this is where the protocol’s overhead actually shows up.
- **Refusal rate** — How often the human declines. Consistently high means the agent is proposing the wrong kind of change, not that the policy is wrong.
- **Agent process restarts** — A subprocess that keeps dying takes the session state with it.

### Failure modes under load
<!--meta polarity=failure-->

- **Stale buffer divergence** — The agent worked from a file on disk while the editor held unsaved changes, so the diff applies to something the developer is not looking at.
- **Prompt fatigue** — A policy that asks about everything trains the developer to approve everything, which is worse than asking about nothing.
- **Orphaned subprocess** — The host exits without terminating the agent, leaving a process holding a workspace and a model connection.
- **Capability mismatch** — The agent assumes a capability the host did not declare and fails partway through a turn rather than at negotiation.

### Readiness checklist
<!--meta polarity=check-->

- Capabilities are negotiated before the first session, and the agent degrades rather than fails when one is absent.
- File reads return the editor’s live buffer, including unsaved changes.
- A refusal returns as a result the agent can act on, never as a protocol error.
- The permission policy is tuned so routine work does not prompt and consequential work always does.
- The host terminates the agent subprocess on exit, including on crash.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../../themes/harness-engineering.md) — One protocol between a coding agent and whatever application hosts it. {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Model Context Protocol](./mcp.md) — Complementary halves: one gives the agent a host, the other gives it capabilities
- [Agent Sandboxing](../../security/agent-sandboxing.md) — The mediated file and permission surface is the boundary, expressed as a protocol

**Requires**

- [AI Agent](../../architecture/ai-agent.md) — It standardises how an agent is hosted, so there has to be an agent

**Often confused with**

- [Agent2Agent](../coordination/a2a.md) — This one hosts an agent inside an application with a person present; the other hands work between independent peer agents

<!-- relationships:end -->
