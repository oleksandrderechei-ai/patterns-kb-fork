---
title: Two-Phase Commit
description: "Commit one change across several stores atomically: a coordinator collects prepare votes, then orders commit or abort, and participants block if it dies."
area: distributed-coordination
owner: Oleksandr Derechei
tags: [transactions, isolation, durability]
status: stable
aliases: ["2PC", XA transaction, atomic commit protocol]
solves: [I update two databases in one request and a crash between the two commits leaves them disagreeing, "one database committed the transfer and the other rolled it back, so the money is gone", "a change must land in several data stores together or not at all, and undo steps are too weak", "rows stay locked after the service that ran the update crashed, and nobody knows whether to commit", a distributed update leaves other readers seeing half of it for a moment]
---

# Two-Phase Commit

Commit one change across several databases or services as a single all-or-nothing step: a coordinator first asks every participant to promise it can commit, then tells all of them to commit or all to abort.

## What it is
<!--meta block=description-->

A change that spans two databases commits twice, and a crash between the two commits leaves one side done and the other not. Two-phase commit adds a coordinator that asks every participant to promise it can commit, then orders all of them to commit or all to roll back. The price is blocking: a participant that voted yes holds its locks until the coordinator answers.

## Explained
<!--meta block=explain-->

Two-phase commit makes a change that touches several databases land in all of them or none. A coordinator, the process running the transaction, first asks every participant, a database taking part, to prepare. Each one does the work, writes it to its own log, keeps its locks and votes yes or no. If every vote is yes, the coordinator writes a commit decision to its own log and tells everyone to commit, and any no or silence means abort. Choose it over a [saga](saga.md) when no one may ever see a half-done state and every participant supports prepare, as with two ledger databases in one data centre. Use a saga when a step belongs to another team or a third party, because they will not hold your locks.

- **Coordinator crash blocks.** Prepared participants hold locks until it returns, so keep its decision log replicated and alert on prepared transactions that stay open.
- **Slow commits.** Each commit waits for the slowest participant plus two message rounds, so keep participants few and close.
- **Lower availability.** Every participant must be up to commit, so use a saga when you cross teams.

**Example.** A transfer moves 100 from ledger A to ledger B. The coordinator sends prepare to both. With both ledgers in one data centre, each locks its row, logs the change and votes yes within a few milliseconds. The coordinator logs commit and sends commit, and both finish within tens of milliseconds. Now suppose the coordinator crashes right after the votes. A and B each hold a row lock and cannot commit or abort alone, because the other might have voted no. Every payment that touches those two accounts waits until the coordinator restarts and replays its log, which can take seconds to minutes.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one change land in two databases or in neither? The coordinator collects a prepare vote from each participant at 1 and 2, logs the decision at 3, and only then sends commit at 4. Each participant holds its locks from its vote until it hears the decision."
flowchart LR
    C["Coordinator"]
    Log[("Decision log")]
    subgraph Locked["Locks held from vote to decision"]
        A["Participant A"]
        B["Participant B"]
    end
    C -->|"1 prepare"| A
    C -->|"1 prepare"| B
    A -->|"2 vote yes"| C
    B -->|"2 vote yes"| C
    C -->|"3 write: commit"| Log
    C -->|"4 commit"| A
    C -->|"4 commit"| B
```

```mermaid caption="What goes wrong when the coordinator fails? One no vote aborts everyone, but a crash after the votes leaves both participants prepared and blocked, holding locks until the coordinator restarts and replays its log."
sequenceDiagram
    autonumber
    participant C as Coordinator
    participant A as Participant A
    participant B as Participant B
    C->>A: prepare
    C->>B: prepare
    A-->>C: yes, locks held
    B-->>C: yes, locks held
    C->>C: log decision: commit
    Note over C: crash before sending commit
    Note over A,B: in doubt, cannot commit or abort alone
    C->>C: restart, replay log
    C->>A: commit
    C->>B: commit
```

The coordinator sends the work to each participant and waits for a vote. A participant that votes yes has written the change and its promise to its own log, so a crash and restart cannot make it forget. The coordinator logs its decision before it tells anyone, because that log entry is what a restarted coordinator uses to finish the job. Participants then commit or roll back and acknowledge, and the coordinator forgets the transaction.

A participant that restarts while prepared must ask the coordinator for the outcome and wait for the answer. That is the in-doubt state, and it is the one place the protocol can stall.

## Variations
<!--meta block=variations-->

- **Three-phase commit** — Adds a pre-commit round between the vote and the commit, so a participant that loses the coordinator can decide by itself from what it saw. It avoids blocking only when the network never partitions and delays stay bounded, so in practice it is rarely used.
- **Presumed abort** — The coordinator does not log or acknowledge aborts, and a participant that asks about a transaction the coordinator has no record of is told to abort. It saves log writes and messages on the common abort path.
- **Consensus-backed coordinator** — The coordinator's decision is stored on several machines with [Quorum & Consensus](./quorum-consensus.md), so losing one machine does not leave participants waiting. Gray and Lamport call this Paxos Commit. Google Spanner runs two-phase commit across groups of replicas, and each group is itself replicated with Paxos.
- **XA transaction manager** — The X/Open XA standard defines how a transaction manager drives resource managers such as databases and message brokers through prepare and commit. Java's transaction API and many application servers use it, so an application can span two systems without writing the protocol.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **All or nothing across stores** — every participant commits or none does, though a reader that takes no locks can briefly see one side before the other, so use lock-taking reads or a timestamp scheme where atomic visibility matters.
- **No undo code to write** — each participant rolls back with its own transaction machinery, where a saga needs a hand-written compensation for every step.
- **Ordinary isolation holds** — locks stay in place until the decision, so a concurrent writer or lock-based reader waits and does not read half a change; snapshot readers do not wait, and global serializability needs more than this protocol.
- **A standard that products implement** — XA and prepared transactions are built into common databases, so you configure it and write no protocol.

### Cons
<!--meta polarity=con-->

- **A coordinator crash blocks participants** — prepared participants hold locks until it returns, so replicate its decision log with [Quorum & Consensus](./quorum-consensus.md) and alert on prepared transactions that stay open.
- **Locks are held across network round trips** — each commit waits for the slowest participant plus two message rounds and two forced log writes, so keep participants few and close together.
- **Availability multiplies** — every participant must be up for the commit to succeed, so three stores at 99.9% each give about 99.7% together, assuming independent failures and counting only participant downtime, and a participant you do not own is a risk you cannot manage.
- **Contention grows with the wait** — a hot row locked through the vote queues every other writer behind the slowest participant, so keep the work between prepare and commit short.
- **Orphaned prepared transactions need manual resolution** — a participant left prepared holds locks until someone resolves it, and an operator's heuristic commit or rollback can leave the stores disagreeing, so audit in-doubt transactions and set timeouts.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **No one may see a half-done change** — two ledgers must agree at every instant, and a reader must never see the debit without the credit.
- **You own every participant** — each supports prepare, such as XA-capable databases in one data centre, and you can fix them when they stall.
- **The transaction is short** — it holds locks for milliseconds, such as the cross-shard transaction inside one distributed database.

### Avoid when
<!--meta polarity=avoid-->

- **A step belongs to another team or a third party** — a payment provider will not hold your locks, so use a [Saga](./saga.md) with [Compensating Transactions](../resilience/compensating-transaction.md).
- **A step runs for minutes or waits on a person** — locks held that long stop everything behind them, so model it as a long-running process with a saga.
- **One database already holds all the data** — a local transaction is simpler and faster than any protocol.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a coordinator that collects votes, logs the decision, then tells everyone"
interface Participant {
  prepare(tx: string): Promise<boolean>; // do the work, log it, keep locks, vote
  commit(tx: string): Promise<void>;
  abort(tx: string): Promise<void>;
}
interface DecisionLog { write(tx: string, d: "commit" | "abort"): Promise<void> }

async function twoPhaseCommit(tx: string, parts: Participant[], log: DecisionLog) {
  // Phase 1: a failed or silent participant counts as a no vote.
  const votes = await Promise.all(parts.map(p => p.prepare(tx).catch(() => false)));
  const decision = votes.every(Boolean) ? "commit" : "abort";

  // The decision exists only once it is durable; a restart replays it from here.
  await log.write(tx, decision);

  // Phase 2: a production version retries each call until the participant
  // acknowledges, because a prepared participant cannot give up and is blocked
  // until it hears the outcome.
  await Promise.all(parts.map(p => decision === "commit" ? p.commit(tx) : p.abort(tx)));
  return decision;
}
```

## In the wild
<!--meta block=wild-->

- **PostgreSQL prepared transactions** — PREPARE TRANSACTION saves a transaction's state and keeps its locks, and COMMIT PREPARED or ROLLBACK PREPARED finishes it later, which lets an external transaction manager run two-phase commit across databases. The max_prepared_transactions setting caps how many can be open. {#wild-postgresql}
- **MySQL XA transactions** — The XA START, XA END, XA PREPARE and XA COMMIT statements let MySQL take part as a resource manager in a distributed transaction driven by an outside transaction manager. {#wild-mysql}
- **X/Open XA and Java Transaction API** — XA is the standard interface between a transaction manager and resource managers such as databases and message brokers, and the Java Transaction API exposes it to application servers, so one transaction can span several of them. {#wild-xa}
- **Google Spanner** — Described in the 2012 Spanner paper: a transaction that spans several groups of replicas commits with two-phase commit, where each group's participant is itself replicated with Paxos so a failed machine does not block the transaction. {#wild-spanner}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **prepare timeout** — how long the coordinator waits for votes before it decides abort; start a little above the participants' p99 prepare time (read it from commit latency p99), and keep it below what other writers can wait on locks; too short aborts healthy slow participants, too long holds every lock longer
- **commit retry interval** — how often the coordinator resends commit or abort to a participant that has not acknowledged; a prepared participant cannot give up, so retry until it answers
- **max prepared transactions** — the cap on transactions a participant may hold in the prepared state, such as PostgreSQL's max_prepared_transactions, which defaults to 0 and so disables prepared transactions until you set it; size it to peak concurrent transactions across all coordinators plus headroom for in-doubt ones
- **participant count** — how many stores one transaction may touch; every added participant lowers availability and raises the wait for the slowest vote

### Signals to watch
<!--meta polarity=signal-->

- **in-doubt transactions** — transactions in the prepared state and how long each has stayed there; the number to alert on
- **commit latency p99** — time from the first prepare to the last acknowledgement, set by the slowest participant
- **abort rate by cause** — votes of no, timeouts and coordinator aborts counted apart
- **lock wait time on rows held by prepared transactions** — how long other writers queue behind a vote

### Failure modes under load
<!--meta polarity=failure-->

- **coordinator crash after the votes** — every prepared participant holds its locks and everything touching those rows waits until recovery; find the stuck transactions through the in-doubt signal and finish each as the decision log says
- **slow participant** — one slow vote stalls the whole transaction and every lock it holds, so latency follows the worst store
- **lost decision log** — the coordinator cannot say what it decided, so an operator must resolve prepared transactions by hand and may guess wrong
- **lock pile-up on hot rows** — writers queue behind prepared transactions and a small stall grows into a backlog

### Readiness checklist
<!--meta polarity=check-->

- Write the coordinator's decision to a durable, replicated log before sending phase two
- Run a recovery job that replays the log and finishes in-doubt transactions after a restart
- Make commit and abort idempotent so retries are safe
- Alert on prepared transactions older than a small multiple of the commit latency p99; page in seconds, not minutes, because a healthy transaction holds its locks for milliseconds
- Keep the number of participants and the work between prepare and commit small

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Multi-Step Processes](../../../themes/multi-step-processes.md) — Why a saga exists: two-phase commit holds locks across services and blocks when the coordinator dies. {#fluency-multi-step-processes}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Quorum & Consensus](./quorum-consensus.md) — Replicating the coordinator's decision log through consensus removes the single point where participants block (Paxos Commit).

**Alternative to**

- [Saga](./saga.md) — Commits all participants atomically with locks held, where a saga commits each step alone and compensates on failure.
- [Pessimistic Locking](./pessimistic-locking.md) — Holds locks across several stores until a decision, where a row lock holds them inside one database.

**Often confused with**

- [Compensating Transaction](../resilience/compensating-transaction.md) — Two-phase commit prevents a half-done state by voting first, where compensation repairs one after the fact.

**Prevents**

- [Dual-Write Inconsistency](../../../hazards/dual-write-inconsistency.md) — Commits both writes atomically, so a crash between them cannot leave the stores disagreeing.

**Exposed to**

- [Deadlock](../../../hazards/deadlock.md) — Can fall into deadlock when participants holding locks while waiting on the coordinator can wait in a cycle

<!-- relationships:end -->
