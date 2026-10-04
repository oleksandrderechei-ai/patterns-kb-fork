---
title: Agent Sandboxing
description: "Bound what an autonomous agent can reach, on the filesystem and on the network"
area: security
owner: Oleksandr Derechei
tags: [security, isolation, access-control]
status: stable
aliases: [agent sandbox, tool-execution isolation, coding-agent confinement]
solves: [the assistant can run any command and my SSH keys are sitting right there, a web page it read told it to do something and it did, I approve so many prompts that I have stopped reading them, a script it wrote deleted files outside the project directory, I cannot tell what it tried to reach during a run that went wrong]
---

# Agent Sandboxing

Confines an autonomous agent's actions to a declared boundary — which directories it may touch and which hosts it may reach — enforced by the operating system rather than by the agent's own good behaviour, so a misled loop cannot read or send what the boundary excludes.

## What it is
<!--meta block=description-->

An agent that runs commands is running code it wrote, steered by text from files, web pages and tool results. Trust that text and you have handed whoever wrote it your credentials, unpushed source and a network connection. A sandbox declares a boundary before the work starts: which directories the agent may read and write, and which hosts it may reach. Routine actions then run without a prompt.

## Explained
<!--meta block=explain-->

An agent sandbox is a boundary, declared before the work starts, around an agent that runs commands: it limits which directories the agent can read and write and which hosts it can reach, and the system enforces it below the agent, so nothing the model is told can move it. You need both limits, because files without network let nothing out, but files with network let credentials leave, and network without file limits gives a confined process something worth sending. Choose it over approving every action by hand when the agent works for long stretches, because people stop reading prompts after the fortieth. A boundary set once lets routine actions run and keeps the few remaining prompts meaningful.

- **Over-broad allowlist** A broad allowlist looks like a sandbox and stops nothing, so list exact hosts and review the list like code.
- **Boundary is the only control** With routine prompts gone, nothing else reviews actions, so read the log of refusals.
- **Growing allowlist** Developer tools need network, so add hosts one at a time as real breakage shows.
- **Damage limit only** It bounds the damage, not the compromise, so give the agent short-lived, narrow credentials.

**Example.** You clone a repository whose README tells the agent to run a script that reads ~/.ssh/id_ed25519 and posts it to evil.example. Without a boundary, the agent has your whole home directory and open network, so the key is gone in under a second. With read access limited to the workspace and an allowlist of registry.internal and api.github.com, the read of ~/.ssh fails and the connection to evil.example is refused and logged. Two checks stopped it, so one over-broad rule, such as allowing all of ~, would have let it through. The cost: the first build fails until you add the package host.

## How it works
<!--meta block=structure-->

```mermaid caption="Why both halves? Cut arrow 3 and the agent can read your keys; cut arrows 4 to 6 and it can send whatever it read. The boundary is declared once, so arrow 7 — the human — is left for the actions that genuinely cross it rather than for every command."
flowchart LR
    Loop["Agent loop"]
    subgraph B["Declared boundary"]
        Work[("Workspace")]
        Proxy["Egress proxy"]
    end
    Home[("Home directory, keys, system files")]:::ext
    Ok["Allowlisted host"]:::ext
    Deny["Everything else"]:::ext
    Human["Human approval"]
    Loop -->|"1 command"| B
    B -->|"2 read and write"| Work
    B -.->|"3 blocked"| Home
    B -->|"4 all egress"| Proxy
    Proxy -->|"5 permitted"| Ok
    Proxy -.->|"6 refused"| Deny
    Loop -->|"7 action outside the boundary"| Human
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Both denials come back as ordinary results, so the loop can adapt rather than die. That is also what makes the refusal log useful: a run that repeatedly tries paths and hosts outside its boundary is the signal that something redirected it."
sequenceDiagram
    autonumber
    participant L as Agent loop
    participant K as OS enforcement
    participant P as Egress proxy
    L->>K: open a path
    alt inside the declared roots
        K-->>L: handle
    else outside
        K-->>L: denied — returned as an observation, not a crash
    end
    L->>P: connect to a host
    alt host on the allowlist
        P-->>L: connection, with the request logged
    else not listed
        P-->>L: refused, host recorded
    end
    Note over L,P: a refusal is evidence — a run that hits many is worth reading
```

## Variations
<!--meta block=variations-->

- **Operating-system sandbox, no container** — Process-level filesystem and network restriction on the host, using the platform's own facilities. Starts instantly and keeps the developer's real toolchain, and the policy has to be written twice because those facilities differ per platform.
- **Container per session** — A whole disposable environment, isolated and reproducible. It is the strongest boundary and the one furthest from the host, so it costs startup time and produces failures the developer cannot reproduce locally.
- **Remote execution environment** — The agent runs entirely off the developer's machine, so the host is never exposed at all. The blast radius moves rather than shrinks — now it is whatever that environment can reach.
- **Egress allowlist only** — The filesystem is trusted because it is a scratch checkout with nothing valuable in it, and only the network is policed. Reasonable in continuous integration, dangerous on a laptop.
- **Scoped credentials** — The agent is issued a token for this task rather than inheriting the developer's, so a leak is bounded to what the task needed. It is [least privilege](./least-privilege.md) at task granularity, and it requires an issuing system the small case will not build.
- **Two-tier boundary** — A permissive inner boundary for the workspace and a strict outer one for everything else, with prompts only at the outer edge. It is the shape that most reduces approval fatigue, and it depends entirely on the inner boundary being drawn correctly.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Bounds the blast radius** of a compromise to what the boundary admits, whatever text talked the loop into it.
- **Buys autonomy**: routine actions proceed without a prompt, so the prompts that remain get read.
- **Enforced below the agent**, so it holds regardless of what the model was persuaded to do.
- **Produces evidence**. Denied paths and refused hosts are a log of what a run tried to do that it should not have.
- **Makes the permitted surface explicit**, which is a thing you can review, diff and argue about.

### Cons
<!--meta polarity=con-->

- **Declaration limits the boundary** — a boundary is only as good as its declaration. An over-broad allowlist looks exactly like a sandbox and stops nothing.
- **Removing routine prompts removes routine human review**, so the boundary is now the entire control rather than one of two.
- **Developer tooling needs network access constantly**, so the allowlist grows under real pressure from real breakage.
- **Containers cost startup time** and drift from the host, producing failures nobody can reproduce outside them.
- **Platform primitives differ**, so a policy proven on one operating system is not proven on another.
- **Everything already inside the boundary is fully reachable**. This bounds the damage; it does not prevent the compromise.
- **Scoped credentials need an issuing system**, which is infrastructure a small team will skip and then quietly do without.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **An agent can execute** commands or code it composed itself.
- **The host holds credentials**, keys or source the task has no need for.
- **Approval fatigue is causing someone** to click through prompts without reading them.
- **The agent reads content from outside** — web pages, tickets, documents — that could carry instructions.

### Avoid when
<!--meta polarity=avoid-->

- **The action is irreversible and externally visible**. Keep an explicit human gate there; a boundary is not a substitute.
- **The agent is read-only with no execution surface**, where the cost buys nothing.
- **You cannot name the permitted paths and hosts**, because then you will write an allowlist that permits everything.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — declare the boundary, enforce it below the agent, keep the refusals"
type Boundary = {
  readRoots:  string[];      // what it may read
  writeRoots: string[];      // narrower than readRoots, almost always
  allowHosts: string[];      // exact hosts; a wildcard here is how allowlists become decoration
};

// The policy is data, so it can be reviewed and diffed. It is not a prompt.
const boundary: Boundary = {
  readRoots:  [workspace, toolchainCache],
  writeRoots: [workspace],
  allowHosts: ["registry.internal", "api.github.com"],
};

// Enforcement sits below the agent: the process itself cannot see outside the roots,
// and every outbound connection goes through a proxy that decides per host.
const sandbox = await confine(agentCommand, {
  filesystem: boundary,
  proxy: { allow: boundary.allowHosts, onRefusal: (host) => refusals.push({ host, at: now() }) },
});

// A refusal is an observation the loop can act on — and evidence you should read afterwards.
if (refusals.length > REFUSAL_ALERT) await flagForReview(sessionId, refusals);

```

## In the wild
<!--meta block=wild-->

- **sandbox-runtime** — An open-source tool that enforces filesystem and network restrictions on arbitrary processes using operating-system primitives, without requiring a container. {#wild-sandbox-runtime}
- **Docker agent sandboxes** — Container-per-session environments for coding agents, giving the strongest isolation and the largest gap from the host toolchain. {#wild-docker-sandboxes}
- **Platform isolation facilities** — The kernel and operating-system mechanisms these tools build on — Linux namespace sandboxing and the macOS sandbox profile mechanism. {#wild-bubblewrap-seatbelt}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Read roots and write roots** — Kept separate and with write always narrower. Collapsing them into one list is the most common way a boundary quietly stops meaning anything.
- **Egress allowlist** — Exact hosts. A wildcard entry converts the allowlist into decoration while leaving every dashboard green.
- **Credential scope** — Whether the agent gets a task-scoped token or inherits the developer’s environment. This decides what a leak costs.
- **Escalation path** — What happens when an action falls outside the boundary — refuse, or ask a human. Refusing everything makes the agent useless; asking about everything recreates approval fatigue.
- **Isolation mechanism** — Host-level process confinement, a container per session, or a remote environment. It trades startup time and fidelity against strength.

### Signals to watch
<!--meta polarity=signal-->

- **Denied path attempts per run** — A few are normal. A run that keeps reaching outside its roots is the clearest sign something redirected it.
- **Refused hosts per run** — Same signal on the other dimension, and the one that would catch an exfiltration attempt.
- **Allowlist growth rate** — Entries added per week. The allowlist expands under real pressure from real breakage, and nothing else tracks that erosion.
- **Prompts per session** — How often the human is asked. Rising means the boundary is drawn too tight; near zero means it may be drawn too wide.
- **Sandbox startup time** — The cost people route around. When it is high, someone will run the agent unsandboxed instead.

### Failure modes under load
<!--meta polarity=failure-->

- **Allowlist erosion** — Entries accumulate one urgent fix at a time until the boundary permits nearly everything, and no single change looked wrong.
- **One-dimension sandbox** — Only the filesystem is confined, or only the network. Both configurations look sandboxed and both leave a working path out.
- **Approval fatigue** — So many prompts that they are approved unread, which is worse than no prompts because it manufactures a record of consent.
- **Environment drift** — The container is far enough from the host that builds fail inside it and nowhere else, so people disable it.
- **Inherited credentials** — The agent runs with the developer’s full environment, so the boundary confines file access while the tokens inside it reach everything anyway.

### Readiness checklist
<!--meta polarity=check-->

- Both dimensions are enforced — filesystem roots and an egress allowlist — never one alone.
- The policy is data in version control, reviewed like a dependency, with no wildcard hosts.
- Enforcement is below the agent, in the operating system or a proxy, not in the agent’s own instructions.
- Denials return as observations the loop can act on, and are recorded.
- The agent holds a task-scoped credential rather than the developer’s environment.
- The boundary itself is tested, with at least one case that must be denied.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — The boundary that buys autonomy {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [AI Agent](../architecture/ai-agent.md) — The action surface it confines is the loop's tool list
- [Agent Client Protocol](../distributed/routing/acp.md) — When the host mediates every read and write, the protocol is where the boundary lives

**Specializes**

- [Least Privilege](./least-privilege.md) — The principle applied to a non-human actor that composes its own commands

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — The agent platforms sell the sandbox: an isolated session per run, discarded after.

<!-- relationships:end -->
