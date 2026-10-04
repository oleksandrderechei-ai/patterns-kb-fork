---
title: Microkernel / Plugin
description: "Minimal core, features loaded as plug-ins"
area: architecture
owner: Oleksandr Derechei
tags: [modularity, extensibility, decoupling]
status: stable
aliases: [plugin-architecture, plug-in, kernel-and-plugins]
solves: [every new file format means editing and redeploying the whole application, customers keep asking for one-off features I do not want in the main product, our core has grown huge because every integration got merged into it, I want other teams to add features without giving them commit access to my code, one experimental feature crashed the entire app for everyone]
---

# Microkernel / Plugin

Keeps a deliberately small, stable core that does almost nothing on its own, and lets every real feature — file formats, auth providers, report types — arrive later as an independently built plug-in the core discovers and wires in without a rebuild.

## What it is
<!--meta block=description-->

When every feature lives in one binary, each release re-tests the whole product and one bad feature ships a broken core to everybody. A microkernel splits the system into a minimal core, which handles lifecycle, wiring and a registry, and plug-ins that carry every feature. Both sides compile against the contract and not each other's internals, so a feature can ship on its own schedule while the contract holds.

## Explained
<!--meta block=explain-->

A microkernel design splits a system into a small core and plug-ins that carry every feature. The core only starts things, wires them together and keeps a registry of what is installed. Plug-ins talk to the core through one published contract, so a feature ships, breaks or is removed without rebuilding the core, and a bad plug-in can be disabled without a core change. Keeping it from crashing the host needs process isolation, as in the sandboxed variation. Choose it when the set of features will outlive your ability to review it, with vendors or other teams building against a contract and not a codebase. For a fixed feature set owned by one team, plain modules give the same code separation without the contract, though not crash isolation.

- **The contract is hard to change.** Version it like a public interface from release one and give a deprecation window.
- **Cooperating plug-ins choke the core.** Give them an event bus to talk over, and keep the bus thin: it routes messages and never interprets them.
- **Load order becomes a subsystem.** Let each plug-in declare what it needs and refuse to start it when that is missing.

**Example.** An editor has a 20,000-line core and 300 installed plug-ins. A change that renames one core method breaks all 300 at once, so the team marks the old name deprecated for two releases and keeps both working. Two plug-ins, a formatter and a linter, must run in order: if they call each other through the core, every call crosses it, so they publish events instead. The linter declares that it needs the formatter, so the core refuses to start it alone. The cost is that the contract carries the old name for two releases.

## How it works
<!--meta block=structure-->

```mermaid caption="What has to change when a new export format arrives? Only steps 2 and 3 — the plug-in is discovered and registers itself — because the dispatch at step 6 is resolved out of the registry and no core call site ever names a plug-in type."
flowchart LR
    Client["Client request"]
    Dir[("Plug-in directory")]
    subgraph Core["Core — names no concrete plug-in"]
        Host["Host / dispatcher"]
        Reg[("Extension registry")]
    end
    subgraph Plugs["Plug-ins — built and shipped separately"]
        P1["PDF export"]:::ext
        P2["OAuth login"]:::ext
    end
    Host -->|"1 discover"| Dir
    Dir -->|"2 load"| P1
    Dir -->|"2 load"| P2
    P1 -->|"3 register extension point"| Reg
    P2 -->|"3 register extension point"| Reg
    Client -->|"4 export request"| Host
    Host -->|"5 look up handler"| Reg
    Host -->|"6 dispatch"| P1
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Strategy per extension point](../gof/behavioral/strategy.md)** — Each plug-in is really a Strategy the core selects at runtime for one extension point — swap the implementation, and the core's call site never changes.
- **Static vs. dynamic loading** — Plug-ins compiled and linked into the core at build time, versus discovered and loaded at runtime from a directory, manifest, or registry — dynamic loading is what makes "install a feature without a rebuild" possible.
- **Client-server microkernel** — The pattern's OS lineage: the kernel supplies only messaging and scheduling, and drivers, file systems, and protocol stacks run as user-space servers behind it — Mach and seL4 push it to its logical extreme.
- **Sandboxed, out-of-process plug-ins** — Run each plug-in in its own process or sandbox — browser extensions, integrated development environment (IDE) language servers — so a crashing or misbehaving plug-in can't take the host down with it.
- **Capability bundles for an autonomous agent** — The same shape for an autonomous agent: a minimal core, plus bundles of instructions and tools it loads only when the task needs them. Bundles are matched by description. Loading lazily saves context budget, not startup time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps the always-loaded core small, stable**, and easy to audit — churn lives in plug-ins, not the kernel.
- **New capability ships as a new plug-in**; with dynamic loading the core is never recompiled or redeployed to add it, while statically linked plug-ins still rebuild it.
- **Independent teams or vendors build** against one published contract without touching each other's code.
- **Unneeded features are simply never loaded**, so the running system stays lean.

### Cons
<!--meta polarity=con-->

- **The plug-in API becomes** the hardest thing to change — every installed plug-in depends on it.
- **Plug-ins that need to cooperate** must go through the core, which can turn it into an unplanned bottleneck; an event bus lowers the coupling but not the traffic through the core.
- **A bug can live in the core**, in a plug-in, or in the wiring between them, which slows debugging.
- **Versioning, discovery, and load order** for many independently built plug-ins becomes its own subsystem.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're shipping a product** whose feature set will keep growing after release, by teams you don't control.
- **Third parties or separate teams** need to extend the system without access to, or a rebuild of, the core.
- **You want an always-on core** to stay small and stable while volatile feature logic lives elsewhere.

### Avoid when
<!--meta polarity=avoid-->

- **Small, fixed feature set** — it is known upfront, so the plug-in indirection is pure overhead.
- **One team owns the whole codebase** — plain modules or packages are simpler than a plug-in contract.
- **Plug-ins would need deep, ad hoc access** to each other's internals — the isolation the core provides breaks down immediately.

Prevents the smell of [Golden Hammer](../../hazards/golden-hammer.md) — with a plug-in per need, no team has to stretch one favorite tool to jobs it was never built for.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal core and one plug-in"
interface Plugin {
  name: string;
  apiVersion: number;
  init(core: Core): void;
}

const API_VERSION = 1;

class Core {
  private commands = new Map<string, (arg: string) => void>();

  register(plugin: Plugin): void {
    if (plugin.apiVersion !== API_VERSION) {
      console.warn(`${plugin.name}: needs API ${plugin.apiVersion}, host has ${API_VERSION}`);
      return; // stay disabled, never half-loaded
    }
    try {
      plugin.init(this); // plug-in wires itself into the core
    } catch (err) {
      console.error(`${plugin.name} disabled`, err); // one bad init does not kill the host
    }
  }
  addCommand(name: string, handler: (arg: string) => void): void {
    this.commands.set(name, handler); // core stays ignorant of who registered
  }
  run(name: string, arg: string): void {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`no plug-in handles "${name}"`);
    handler(arg);
  }
}

// A plug-in the core has never heard of at compile time
const markdownExport: Plugin = {
  name: "markdown-export",
  apiVersion: 1,
  init: (core) => core.addCommand("export", (path) => console.log(`exporting to ${path}`)),
};
const core = new Core();
core.register(markdownExport);
core.run("export", "./out.md");
```

## In the wild
<!--meta block=wild-->

- **VS Code** — Ships a small editor core and runs extensions in a separate Extension Host process, activating each lazily via declared activation events so a slow extension cannot block the editor's UI thread; heavy language features are pushed further out over the Language Server Protocol. {#wild-vscode}
- **Eclipse / OSGi** — Built its IDE as OSGi bundles that declare versioned dependencies and contribute to extension points; the Equinox runtime resolves them and can install, start, stop, or update a bundle without restarting the host. {#wild-eclipse-osgi}
- **seL4** — A formally verified microkernel whose kernel provides only inter-process communication (IPC), scheduling, and capability-based memory management; drivers, file systems, and network stacks run as user-space servers isolated from the kernel and from each other by capabilities. {#wild-sel4}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Plug-in isolation mode** — Whether plug-ins run in the host process or in a separate process / sandbox. Out-of-process isolation stops a crashing or looping plug-in from taking the core down, at the cost of an IPC hop per call. Decide by plug-in trust and worst-case call duration, and compare the per-call IPC latency with the host's responsiveness budget.
- **Load strategy: eager vs lazy** — Whether plug-ins are activated at startup or on demand when first needed. Lazy activation keeps host startup fast as the installed set grows, at the cost of a first-use delay and the need to declare what triggers activation.
- **Extension API version and compatibility policy** — The versioned contract every plug-in binds to, plus the deprecation rules that decide when an old plug-in still loads against a newer core.
- **Plug-in discovery source** — Where the core looks for plug-ins — a directory, a manifest, or a registry — which sets how installation and update work.

### Signals to watch
<!--meta polarity=signal-->

- **Host startup time by plug-in activation** — Total startup broken down by how long each plug-in takes to activate, exposing the ones that inflate cold-start cost.
- **Per-plug-in CPU and memory** — Resource use attributable to each plug-in — observable directly when plug-ins run out-of-process.
- **Plug-in crash / restart rate** — How often individual plug-ins fail, isolating a flaky extension from a genuine core problem.
- **Host blocking time** — How long the core stalls waiting on plug-in calls. A long stall means a plug-in is holding a shared thread. Set a ceiling per call, alert past it and record which plug-in held it.

### Failure modes under load
<!--meta polarity=failure-->

- **A plug-in blocks the core** — In an in-process model a slow or looping plug-in hangs the host's shared thread, freezing every other feature — the classic driver for an out-of-process host.
- **Plug-in crash takes down the host** — Without sandboxing, an unhandled fault in one plug-in crashes the whole process rather than just disabling that feature.
- **API version skew** — A plug-in built against an older or newer extension contract fails to load, or loads and misbehaves, once the core moves. Reject at load on a declared API version range and keep the plug-in disabled, not half-loaded.
- **Load-order and dependency cycles** — Plug-ins that depend on one another initialize non-deterministically, so a working install breaks when the discovery order shifts. Declare dependencies in a manifest, sort them at load, and fail only the plug-in in a cycle, naming the cycle.

### Readiness checklist
<!--meta polarity=check-->

- The extension API is versioned with a documented compatibility and deprecation policy.
- Untrusted or heavy plug-ins run out-of-process or sandboxed so a crash cannot take the core down.
- Plug-in activation is lazy where possible, and per-plug-in startup cost is measured.
- A plug-in failure is isolated and surfaced (the plug-in is disabled and reported) rather than fatal to the host.
- Plug-in dependencies and load order are declared explicitly, not left to discovery order.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Keep a minimal core and ship each feature as a plug-in. {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strategy](../gof/behavioral/strategy.md) — Plug-ins are swappable strategies for the core
- [Bulkhead](../distributed/resilience/bulkhead.md) — Run each plug-in sandboxed so one crash cannot take the host down
- [Open/Closed Principle](../../principles/open-closed.md) — The core is closed to edits; features arrive as new plug-ins

**Alternative to**

- [Hexagonal](./hexagonal.md) — Plug-ins are discovered and loaded at run time, often from third parties

**Prevents**

- [Golden Hammer](../../hazards/golden-hammer.md) — A plug-in per need resists forcing one tool everywhere

<!-- relationships:end -->
