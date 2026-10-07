---
title: Golden Hammer
description: One familiar tool applied to every problem
area: hazards
owner: Oleksandr Derechei
tags: [anti-pattern, code-smell, maintainability, abstraction]
status: stable
aliases: [Law of the Instrument, Maslow's Hammer]
solves: [we reach for the same tool on every problem without asking whether it fits, we put a message broker between two functions in the same process, a workflow engine drives a single boolean flag, the only answer to why we used this is that it is what we used last time]
---

# Golden Hammer

One familiar tool, framework, or pattern gets reached for on every problem — not because it fits, but because it's the one the team already knows.

## What it is
<!--meta block=description-->

A **golden hammer** is a favourite tool a team applies to every problem because it is the one they know, not because it fits. You recognise it in simple problems solved with heavy machinery, such as a message queue for one write, and in design talks where nobody names an alternative. The defining trait is the missing decision, not the tool: the same tool chosen after comparing a second candidate is no hammer.

## Explained
<!--meta block=explain-->

A golden hammer is a favourite tool that a team applies to every problem, whether or not it fits. It starts with a real win: the tool solved something well, the team became fluent, and fluency became the default lens. It then seals itself, because each use makes the team faster with this tool and no faster with anything else. Simple problems get heavy machinery, such as a message queue for one write, and every problem inherits the tool's failures and running cost. The failure is the missing decision, not the tool, so the counter is a procedure. Before settling, someone names a second candidate and says in one sentence why it loses. If nobody can name one, you have found the problem. Put the tool behind an interface your own code owns, so replacing it later is one implementation, not a rewrite. Try the alternative on a real slice of work for a week, because use settles what argument cannot.

- **Decision time.** Naming a second candidate adds a short meeting; cap it at one sentence per loser.
- **Extra interface.** The wrapper is code to maintain; wrap only tools that touch many call sites.

**Example.** A team that runs Kafka well needs to save 5 settings changes a day from an admin screen. Out of habit they publish each change to a topic, and a consumer service writes it to the database, so two extra processes need deployment, monitoring and on-call. Asked for a second candidate, someone says a direct database write in the same request does the job. A one-week trial on this one screen confirms it. The team keeps Kafka for cases with a second consumer or a sustained high event rate.

## How it happens
<!--meta block=causes-->

```mermaid caption="The reinforcing loop: fluency with one tool becomes the reason to keep choosing it, which further narrows the team's fluency."
flowchart TB
    A["Team masters tool X on a real win"] -->|"early success sticks"| B["X becomes the default reach"]
    B -->|"reach for X first"| C["New problem framed to fit X"]
    C -->|"alternatives go unused"| D["Skill with alternatives atrophies"]
    D -->|"X is even more the default"| B
    C -->|"forced beyond its fit"| E["X gets stretched past its sweet spot"]
```

- The tool had a genuine early win, and that win quietly becomes the default answer to every later question.
- Learning a second tool well takes time, so people stay with the familiar one and skip that cost, and the skill gap widens with every project.
- Nobody owns cross-cutting technology choices, so each new decision-maker just reaches for what they already know.
- "We shipped with X" is a fact about one project; it quietly turns into "we always ship with X" for every project after it.
- Internal advocates and past success stories reinforce the tool as the one true answer, beyond the scope it actually earned.

## Why it hurts
<!--meta block=cost-->

- Simple problems get complex machinery: one write goes through a distributed queue, one conditional runs through a rules engine.
- The stretched tool needs workarounds and escape hatches for a job it was not built for, and they add complexity the rest of the system does not need.
- Operational cost compounds: every problem the tool is applied to inherits its failure modes, latency and ops burden, even the trivial ones.
- Without deliberate practice on alternatives, skill with them tends to fade, so the default can become the only option the team can staff, and each choice deepens the lock-in.
- Problems that genuinely need a different tool get bent to fit the familiar one, producing designs that fight the grain of the problem.
- Reviews judge fit against habit rather than against the problem's actual shape, so the mismatch passes unquestioned.
- One tool everywhere is a shared dependency, so a single outage, upgrade or licence change hits every system built on it.

## How to avoid it
<!--meta block=mitigation-->

Make someone name a second candidate. Before the choice is settled, one person names another way to solve it and says in a sentence why it loses. An hour of comparison for a small, reversible choice is what turns a reflex back into a decision. If nobody can name an alternative, you have found the problem, not a formality to skip. Keep this step for choices that are costly to reverse, and name a real rival, because a strawman loser makes it a ritual.

Then make the choice reversible before it becomes permanent. Put the tool behind an interface your own code owns and keep its vocabulary out of the callers, so replacing it later is one implementation rather than a rewrite. And try the alternative on a real slice of work instead of in a document, because the argument is usually about fluency, and a week of using the other thing is the only honest price for it. Wrap only where the tool touches many call sites; one call site needs no wrapper. Before the trial, write one measurable pass criterion, such as deploy steps or ops load, and judge the slice against it.

Someone has to own the defaults, or the reflex owns them. Keep a short written list of what the team reaches for by default and, against each entry, the boundary where it stops applying. A default with a stated edge is a decision, and one without an edge is the habit again in writing. Revisit that list on a fixed cadence rather than when a project is late, because a deadline is exactly when the familiar tool wins every argument.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Microkernel / Plugin](../patterns/architecture/microkernel.md) — A plug-in per need resists forcing one tool everywhere
- [Hexagonal](../patterns/architecture/hexagonal.md) — A port owned by your code means replacing the favourite tool is one adapter, not a rewrite

**Threatens**

- [Microservices](../patterns/architecture/microservices.md) — The style gets applied to every system regardless of fit
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — The history log gets used where a plain table would do
- [CQRS](../patterns/architecture/cqrs.md) — The read and write split gets adopted by habit in simple create-read-update-delete apps

<!-- relationships:end -->
