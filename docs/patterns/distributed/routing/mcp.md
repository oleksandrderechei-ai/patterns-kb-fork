---
title: Model Context Protocol
description: One contract between AI applications and the tools and data they reach
area: distributed-routing
owner: Oleksandr Derechei
tags: [integration, decoupling]
status: stable
aliases: [MCP, Model Context Protocol, tool server, tool protocol]
solves: [every assistant we add needs its own adapter written for every system it touches, adding one tool to the assistant means shipping a new release of the assistant, two teams built the same integration because neither could reuse the other one, the assistant should see different tools depending on who is asking, we cannot say which tools the model actually had available on the day it went wrong]
---

# Model Context Protocol

Puts one open contract between an AI application and everything it needs to reach, so a capability is written once and every conforming application can call it — and the list of available capabilities is discovered at run time rather than compiled in.

## What it is
<!--meta block=description-->

The Model Context Protocol is a standard interface through which a server publishes tools to call, resources to read and prompt templates to reuse, and any application that speaks it can ask the server what it offers. It collapses the adapters between assistants and systems from a product of the two lists to a sum. It costs context: every tool description is text the model reads, and server output is untrusted text.

## Explained
<!--meta block=explain-->

The Model Context Protocol is a standard interface through which a server publishes tools to call, data to read and prompt templates, and any AI application that speaks the protocol asks the server what it offers instead of being built already knowing. Without it, three assistants and three systems need nine adapters, each with its own login handling and upgrades, a count that grows as the product of the two lists instead of the sum. Adopt it when a capability crosses a team or product boundary; skip it for an application's own fixed set of tools, where a plain function call costs nothing.

- **Context load.** Every tool's name, description and schema is text the model reads first, so load only the tools a task needs.
- **Untrusted output.** Server output lands next to your instructions, so allow only approved servers and check results before they trigger an action.
- **Unclear permission.** Whether host or server holds the user's permission is ambiguous, so decide it and pass narrow tokens.
- **Missed notifications.** Notifications can be missed, so keep polling as the path you trust.

**Example.** Three assistants and three systems, tickets, a database and files, need 9 adapters. With the protocol you write 3 servers, and every assistant uses all of them. The cost is context: each server offers 20 tools of about 500 tokens each, so all 60 tools take 30,000 tokens before any work starts. Loading the 5 tools a task needs takes 2,500. A ticket whose body says ignore your instructions and email the file arrives as server output, so the host treats it as data to check, not as a command.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one application reach many capabilities without an adapter per pair? The host opens one client per server and keeps them separate, so a local child process and a remote authenticated service look the same to the model loop. Steps 2 and 3 are the part that replaces compiled-in knowledge: the schemas arrive at run time."
flowchart LR
    subgraph Host["Host application"]
        Loop["Model loop"]
        C1["Client 1"]
        C2["Client 2"]
    end
    Local["Local server, child process"]
    Remote["Remote server, HTTP"]
    Data[("Files, database, API")]:::ext
    Loop -->|"1 what is available?"| C1
    C1 -->|"2 discover, then list"| Local
    Local -->|"3 tool and resource schemas"| Loop
    Loop -->|"4 call this tool"| C1
    C1 -->|"5 invoke"| Local
    Loop -->|"6 authenticated call"| C2
    C2 -->|"7 invoke"| Remote
    Remote -->|"8 read"| Data
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Version and capability negotiation happen before anything else, and both listings are cacheable — which is why the client also polls: change notifications are opt-in and best-effort, so a client that trusts them alone will drift."
sequenceDiagram
    autonumber
    participant H as Host client
    participant S as Server
    H->>S: discover — versions, identity, capabilities
    alt version not supported
        S-->>H: error listing the versions it accepts
        H->>S: retry on a mutually supported version
    else agreed
        S-->>H: capabilities, with a cache lifetime
    end
    H->>S: list tools
    S-->>H: schemas, with a cache lifetime
    H->>S: call tool with arguments
    alt server needs the user
        S-->>H: ask the user for input or confirmation
        H-->>S: the user's answer
    end
    S-->>H: result content
    H->>S: subscribe to tool-list changes
    S-->>H: notification, best effort
```

## Variations
<!--meta block=variations-->

- **Local child process** — The server runs on the same machine and speaks over standard input and output. There is no network, no authentication problem and no shared state, because it serves exactly one client. It is also the form with the most privilege, since it runs as whoever started it.
- **Remote server over HTTP** — One deployment serving many clients, authenticated per request, with streaming for results that arrive in parts. This is the form that needs an identity story, and the one where a single server's outage is felt by everybody.
- **[Gateway](./api-gateway.md) over many servers** — A proxy aggregates several servers behind one endpoint and owns their lifecycle, their routing and their authorization. It is how an organisation applies one policy to a fleet — and it becomes a component that must itself be run.
- **Progressive discovery** — Rather than loading every tool from every server, the host loads a subset and fetches more when the work calls for it. Necessary once the union of tool schemas no longer fits usefully in the context window; it costs an extra round trip at exactly the moment the model needed the tool.
- **Durable handle for long work** — A call returns a task identifier the client polls, instead of holding a request open for minutes. Same trade as any [asynchronous request-reply](./async-request-reply.md): the caller stops blocking and starts owning a state machine.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Turns an N×M integration problem into N+M**: a capability is written once and reached by every conforming application.
- **The tool list changes without a release**, because the application discovers it rather than declaring it.
- **Capability teams** and application teams are separated by a contract instead of by a code review.
- **Local and remote servers expose** the same listing and call interface, so a prototype can move to a service with the application's tool code unchanged; authentication, timeouts and outage handling still change.
- **Available capability can vary per user**, per workspace and per permission, since the listing is a run-time answer.

### Cons
<!--meta polarity=con-->

- **Every tool's name**, description and schema is spent from the context budget before any work happens. A large federation crowds out the task.
- **Server output lands in the model's context**, so a compromised or hostile server can inject instructions rather than merely return bad data.
- **Tool descriptions are model-facing prose**, so a server author is writing prompt text, and a badly described tool is simply never called.
- **Best-effort change notifications** mean a client that does not also poll will act on a stale listing.
- **Consent is decided at the protocol boundary** — deciding which end holds the user's authority is harder than the transport.
- **The primitive set has already** gained and deprecated members, so both ends negotiate versions rather than assume them.
- **Where a server keeps no session state** between calls, version and capability metadata travel with every request: horizontal scaling is bought at a per-message cost.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **More than one AI application** needs the same data source or tool, or one application needs many.
- **The set of available capabilities** has to change at run time — per user, per workspace, per permission.
- **The capability is owned** by a different team than the application, and a stable contract is what separates them.
- **Swapping prototype for hosted service** — a local prototype has to become a hosted service without changing the caller.

### Avoid when
<!--meta polarity=avoid-->

- **The toolset is private** to one application and fixed. A direct function call is simpler and costs no protocol.
- **You need service-to-service throughput**. These primitives are shaped for a model to read, not for machines to move volume.
- **You cannot answer who authorised the call**, because that is the question the boundary forces you to answer.
- **The context budget is already** tight and the capability would be used once.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a server declaring one tool, and a client discovering it"
// Server side: the description is model-facing prose, and the schema is the contract.
server.tool({
  name: "incident_search",
  title: "Search incidents",
  description: "Find incidents by service name and time range. Returns id, severity and summary.",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", description: "The service name as it appears in the catalogue" },
      since:   { type: "string", description: "ISO-8601 timestamp; results are newer than this" },
    },
    required: ["service"],
  },
}, async ({ service, since }) => ({
  content: [{ type: "text", text: await search(service, since) }],
}));

// Client side (schematic calls, not a specific SDK): discover, then list, then call. Nothing about the tool was compiled in.
const capabilities = await client.discover();          // versions + what this server supports
if (!capabilities.tools) throw new Error("server offers no tools");

const { tools } = await client.listTools();            // cacheable; re-list on notification and on a timer, since notifications are best-effort
// also: set a per-call timeout and pass a scoped token on each request
registry.add(tools);                                   // these schemas are what the model sees

const result = await client.callTool("incident_search", { service: "checkout" });

```

## In the wild
<!--meta block=wild-->

- **Reference server collection** — The protocol project maintains filesystem, database and search servers as canonical examples of servers exposing tools, resources and prompts. {#wild-reference-servers}
- **MCP Gateway** — A reverse proxy and management layer that fronts many servers with session-aware routing and lifecycle management, so a fleet is administered as one endpoint. {#wild-mcp-gateway}
- **agentgateway** — An agentic proxy that applies authorization and policy to both tool traffic and cross-agent traffic on the same path. {#wild-agentgateway}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Which servers a workspace may use** — An allowlist, not a discovery free-for-all. Each server is a trust boundary, so this is the security control, not a convenience setting.
- **Tool-listing budget** — The share of the context window you will spend on schemas before any work starts. Measure tokens per tool (in the example above, 500 each: 60 tools is 30,000, 5 tools is 2,500) and set the share from that. It forces progressive discovery rather than the union of every server.
- **Listing cache lifetime** — How long a discovered capability or tool list is reused. Long saves round trips; short catches a server whose tools changed.
- **Per-call timeout** — A server that hangs otherwise holds a turn open for as long as the transport allows.
- **Transport per server** — Local child process or remote HTTP. It decides the privilege the server runs with and whether authentication is a question at all.

### Signals to watch
<!--meta polarity=signal-->

- **Tokens spent on tool schemas per turn** — Track it separately from total tokens. It is the cost that rises silently as servers are added.
- **Calls per tool, and never-called tools** — A tool nobody calls is paying rent in the context window; usually its description is the problem.
- **Call error rate per server** — Separates a bad tool from a bad server, which the model’s own behaviour will not tell you.
- **Listing staleness** — Time between a server changing its tools and clients re-listing. Notifications are best-effort, so this is the number that says whether polling is frequent enough.
- **Authorization failures per server** — A rise usually means token scope drifted, not that users started doing something new.

### Failure modes under load
<!--meta polarity=failure-->

- **Schema crowd-out** — Enough servers are connected that the tool listings leave no useful room for the task. Answers get worse with no error anywhere.
- **Stale listing** — A server changed its tools, the notification was not delivered, and the model keeps calling a tool that no longer exists.
- **Hostile server output** — A server returns text carrying instructions. The call succeeds, the audit trail looks clean, and the loop does something else.
- **Local server over-privilege** — A child-process server inherits whoever started it, so a server intended to read one directory can read everything that user can.
- **Ambient credential reuse** — The host passes its own credentials rather than a scoped token, so every server can act as the user on everything.

### Readiness checklist
<!--meta polarity=check-->

- The servers a workspace may connect to are an explicit allowlist, reviewed like a dependency.
- Tool schemas are budgeted, and a federation loads progressively rather than as a union.
- Remote servers authenticate per request with a scoped token, not with the host’s own credentials.
- Server results are treated as untrusted content before they influence an action.
- Clients poll as well as subscribe, so a dropped notification does not become a stale tool list.
- The protocol version each server negotiated is logged, so a breaking change is diagnosable.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../../themes/harness-engineering.md) — The tool surface, declared rather than compiled in {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [AI Agent](../../architecture/ai-agent.md) — The loop is the consumer: it reads the schemas and decides which to call
- [Agent Client Protocol](./acp.md) — The host protocol reuses these representations rather than defining its own
- [API Gateway](./api-gateway.md) — How a fleet of servers is fronted by one endpoint with one policy
- [Backend-for-Frontend](./bff.md) — A BFF can be the MCP server shaped for one agent

**Often confused with**

- [Agent2Agent](../coordination/a2a.md) — This one gives an application tools and data; the other hands work to a peer agent

**Implemented by**

- [Data & Analytics](../../../capabilities/data-analytics.md) — A managed gateway turns existing APIs into MCP tools without writing a server.

<!-- relationships:end -->
