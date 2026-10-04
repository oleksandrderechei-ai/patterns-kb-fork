---
title: Agent2Agent
description: Delegate a stateful task to an agent you did not build
area: distributed-coordination
owner: Oleksandr Derechei
tags: [integration, boundaries]
status: stable
aliases: [A2A, Agent2Agent, agent-to-agent protocol, agent interop]
solves: [we need work done by a system another company runs and neither side will expose its internals, the delegated job takes twenty minutes and an HTTP request cannot stay open that long, the other side needs an answer from our user halfway through and there is nowhere to ask, we have no way to cancel work we already handed off, every new partner integration is a bespoke API and a bespoke contract]
---

# Agent2Agent

Lets one autonomous agent hand work to another it did not build and cannot see inside, by making the delegated unit a task with a published lifecycle — submitted, working, waiting on input, finished — rather than a request with a reply.

## What it is
<!--meta block=description-->

Calling an agent built by another team as a plain HTTP endpoint breaks when the work takes minutes or needs an answer from the user halfway. Agent2Agent makes the delegated unit a task, with an id and a visible lifecycle, and both sides can send messages on it. The peer is found through a card it publishes. You gain reach across a boundary, and you pay in opacity.

## Explained
<!--meta block=explain-->

Agent2Agent lets one AI agent hand a long job to another agent that a different team built, without either side seeing the other's prompts, tools or model. The job becomes a task with an id and a visible state: submitted, working, waiting for input, then finished, failed or cancelled. Either side can send more messages on that task, so the peer can come back with a question instead of guessing. The peer is found by reading a card it publishes at a fixed web address, which lists its skills, its endpoint and how to log in. Choose it only across a boundary you do not control: inside one application a function call is right, and for reaching your own tools a tool protocol needs far less machinery.

- **Opacity** You can reject a bad result but never diagnose it; check every returned file and record the card version with each task.
- **Stalled tasks** A peer that dies leaves a task that never finishes; run a sweeper that cancels stalled tasks.
- **Public callback** The callback address the peer posts to is public; authenticate it and rate-limit it.
- **Untrusted output** Whatever comes back is untrusted text; validate it before your model reads it.

**Example.** Your contract-review agent delegates a 40-page translation to a partner's agent. The card shows a translate-legal skill, so you send the brief and keep task id t-17. After 4 minutes the peer moves to input-required and asks which spelling of the company name to use. You answer on the same task. Another 6 minutes later the state is completed, 10 minutes in all, past a 30 s HTTP timeout. You registered a webhook because a held connection cannot last 10 minutes, and you poll every 5 minutes in case the callback is lost. Your acceptance check finds one missing section, so you reject the file. The cost is that you can say it is wrong but not why.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one agent give work to another it cannot see inside? The card at step 1 carries everything needed to call — skills, endpoint, auth scheme — so nothing about the peer is configured ahead of time. Steps 5 to 7 are the reason this is a task and not a request: the work outlives any connection either side is willing to hold open."
flowchart LR
    A["Calling agent"]
    Card[("Capability card, well-known path")]
    R["Remote agent"]:::ext
    Tasks[("Task store")]
    Hook["Caller's webhook"]
    A -->|"1 fetch card"| Card
    A -->|"2 authenticate as the card requires"| R
    A -->|"3 send message, task created"| R
    R -->|"4 record state"| Tasks
    R -->|"5 status and artifact events"| A
    R -->|"6 needs more input"| A
    R -->|"7 post on completion"| Hook
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Four non-terminal states and four terminal ones, which is what makes the delegation resumable. The webhook branch inverts the trust direction — the remote agent now calls into your network — so that endpoint needs its own authentication and abuse limits."
sequenceDiagram
    autonumber
    participant A as Calling agent
    participant R as Remote agent
    participant W as Caller's webhook
    A->>R: send message
    R-->>A: task id, state submitted
    R-->>A: state working
    alt needs the user
        R-->>A: state input-required
        A->>R: message on the same task
    else needs credentials
        R-->>A: state auth-required
        A->>R: retry with a token for the named scheme
    end
    alt caller still connected
        R-->>A: artifact events, then completed
    else connection dropped
        R->>W: post completion to the registered webhook
        A->>R: fetch task to reconcile
    end
```

## Variations
<!--meta block=variations-->

- **Synchronous send** — One message, one reply, for work that finishes inside a request. It is the cheapest form and the one that discards most of what the pattern offers, so use it only where the task genuinely is short.
- **Streamed task** — Status and artifacts arrive as they are produced, over a held-open connection, with a resubscribe call for reconnection. Good for work measured in seconds to a few minutes, where the caller can afford to wait and wants to show progress.
- **Webhook-backed task** — The caller registers a callback and hangs up. This is the only form that survives work measured in hours, and it makes your callback endpoint part of the remote agent's attack surface.
- **Brokered discovery** — A registry resolves an agent by the capability you need rather than by domain. The well-known path only helps when you already know who to ask; finding an unknown peer needs a directory the protocol itself does not define.
- **Proxied delegation** — A [gateway](../routing/api-gateway.md) sits between the two agents, applying authorization, quota and inspection to the delegated traffic. It is how an organisation keeps one policy over many peers, at the cost of another component in the path.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Capability you do not have to build** — it reaches capability nobody in your organisation has to build, and keeps the peer free to change everything behind its card.
- **Survives work that outlives a connection**, because state lives in the task rather than in the socket.
- **Stays interactive**: the waiting-on-input state lets a long delegation come back for an answer instead of guessing.
- **Cancellation is defined rather than improvised**, so a caller that changes its mind has somewhere to say so.
- **Content is modality-agnostic** — text, files and structured data travel in the same task shape.

### Cons
<!--meta polarity=con-->

- **Opacity is the point and the bill**. A bad result can be rejected but not diagnosed, and the peer's behaviour can change without a version bump.
- **Delegating to a non-deterministic peer** makes your own output non-deterministic, and your evaluation suite now covers something you do not control.
- **Task state is real durable** state on both sides, so both need storage and a reconciliation path for tasks that stall.
- **Webhooks invert the trust direction**: the remote agent calls into your network, and that endpoint must be authenticated and rate-limited like any public one.
- **Discovery by well-known path presumes** you already know the domain, so anything resembling a marketplace needs a registry this does not provide.
- **Carrying the user's authority across** the boundary is a delegation problem, and scoping that consent correctly is harder than the transport ever is.
- **Every artifact you accept** is untrusted content entering your own model's context.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The counterpart is built**, deployed and versioned by someone else and has to stay a black box.
- **The delegated work runs long** enough that a synchronous call cannot hold it.
- **The caller must be able to cancel**, or the callee must be able to come back for more input.
- **Several peers offer overlapping capability** and you want to choose one at run time from what it publishes.

### Avoid when
<!--meta polarity=avoid-->

- **You are connecting an application** to its own tools and data. That is what the [tool protocol](../routing/mcp.md) is for, and it is far less machinery.
- **Both agents are yours, in one deployment**. Call the function.
- **The traffic is high-volume and latency-sensitive**. This shape is conversational, not transactional.
- **You cannot price a wrong answer** — you cannot state what a wrong answer from the peer costs you, because you will have no way to bound it afterwards.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — discover a peer, delegate, and answer when it asks"
// 1. Discover: the card says what it can do, where to call it, and how to authenticate.
const card = await fetch(`https://${domain}/.well-known/agent.json`).then(r => r.json());
if (!card.skills.some(s => s.id === "translate-legal")) throw new Error("peer lacks the skill");

const auth = await credentialsFor(card.securitySchemes);   // obtained out of band, not in the payload

// 2. Delegate: a task, not a request. Keep the id — it is the handle for everything after this.
let task = await rpc(card.url, "message/send", {
  message: { role: "user", parts: [{ type: "text", text: brief }] },
}, auth);

// 3. Follow it. The peer may need something only the caller can supply.
while (!TERMINAL.has(task.status.state)) {
  if (task.status.state === "input-required") {
    const answer = await askTheUser(task.status.message);
    task = await rpc(card.url, "message/send", { taskId: task.id, message: answer }, auth);
  } else {
    task = await rpc(card.url, "tasks/get", { id: task.id }, auth);   // or subscribe to the stream
  }
}

if (task.status.state !== "completed") return reject(task);
return task.artifacts;    // untrusted content — validate before it reaches your own context

```

## In the wild
<!--meta block=wild-->

- **The A2A specification** — A published, versioned protocol defining the capability card, the task lifecycle, and the message, part and artifact objects. {#wild-a2a-spec}
- **agentgateway** — An agentic proxy that sits between agents and applies authorization and policy to delegated traffic rather than leaving each pair to negotiate it. {#wild-agentgateway-a2a}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Card refresh interval** — How often a peer’s capability card is re-fetched. Too long and you authenticate against a scheme it has retired; too short and you fetch on every call.
- **Task timeout and cancellation policy** — How long you wait before cancelling. Without one, a peer that stops responding leaves tasks open forever.
- **Update channel per task** — Streamed events or a registered webhook. Pick by expected duration, not by convenience — a stream cannot survive an hour.
- **Webhook authentication** — How the remote agent proves it is the one posting to your callback. This endpoint is public by construction.
- **Token scope for delegation** — What authority the peer receives on the user’s behalf, and for how long. Ambient credentials here are the whole problem.

### Signals to watch
<!--meta polarity=signal-->

- **Task state distribution** — The share sitting in each state. A growing input-required pile means nobody is answering; a growing working pile means a peer has stalled.
- **Time to terminal state** — Per peer, as a distribution. It is the number that tells you whether a partner has quietly got slower.
- **Rejected and failed rate per peer** — Separates your bad briefs from their bad answers, which one combined number hides.
- **Webhook delivery failures** — Undelivered completions become tasks you think are still running; reconcile by polling.
- **Artifact validation failures** — How often a returned artifact fails your own acceptance check. Rising means the peer changed behind its card.

### Failure modes under load
<!--meta polarity=failure-->

- **Stalled task** — The peer stops updating and never reaches a terminal state. Your side holds durable state for work nobody is doing.
- **Missed completion** — The stream dropped and the webhook failed, so a finished task looks in-flight until something reconciles it.
- **Silent peer change** — The remote agent’s behaviour changes with no version signal, so your output changes and nothing in your system changed.
- **Webhook abuse** — The callback endpoint is discovered and used by someone other than the peer, since it must be reachable from outside.
- **Over-scoped delegation** — The token handed to the peer grants more than the task needed, so a compromise there is a compromise of everything it can reach.

### Readiness checklist
<!--meta polarity=check-->

- Every task has a timeout and a cancellation path, and something sweeps the ones that stall.
- Completions are reconciled by polling as well as received, so a dropped webhook is not a lost task.
- The callback endpoint is authenticated and rate-limited like any other public surface.
- Delegated authority is a scoped, expiring token — never the caller’s own credentials.
- Returned artifacts pass your own acceptance check before they reach a model or a user.
- The peer’s card and protocol version are recorded with each task, so a behaviour change is diagnosable.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../../themes/harness-engineering.md) — Hand a long, stateful task to an independent agent and follow its lifecycle. {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Asynchronous Request-Reply](../routing/async-request-reply.md) — The task handle, the polling and the callback are the same shape this pattern names
- [Service Discovery](../routing/service-discovery.md) — The capability card at a well-known path is a self-describing registry entry

**Requires**

- [AI Agent](../../architecture/ai-agent.md) — There is nothing to delegate to until both ends are agents

**Often confused with**

- [Model Context Protocol](../routing/mcp.md) — That one connects an application to capabilities; this one connects independent agents

**Implemented by**

- [Data & Analytics](../../../capabilities/data-analytics.md) — Each cloud's managed agent runtime speaks A2A, so a hosted agent can call another.

<!-- relationships:end -->
