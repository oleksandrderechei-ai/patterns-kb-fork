---
title: Google Docs
description: A hundred people edit one document at once and every screen converges on the same text within 100 ms
area: designs-advanced
owner: Oleksandr Derechei
tags: [consistency, latency, resource-management]
status: stable
aliases: [collaborative document editor, real-time collaborative editing]
solves: [two people type into the same document at the same time and one person's edits silently overwrite the other's, edits arrive in a different order on each screen so everyone sees a slightly different version of the text, a collaborator's keystrokes and cursor must show up on my screen in well under a tenth of a second, one real-time server holds the sockets for every open document and tips over past a few thousand users, the edit history for a hot document grows without bound and replaying it to each new joiner takes seconds]
---

# Google Docs

A collaborative editor lets many people type into one document at the same time and see each other's keystrokes and cursors live. The whole design turns on a single question — when two edits collide, how does every screen still converge on the same text? Sockets, storage, and scale all follow from the answer.

## Understanding the problem
<!--meta block=description-->

A browser document editor where several people edit the same plain text at once and see each other's changes and cursors live. Rendering is not the hard part; agreement is, because edits arrive from many keyboards over an unreliable network and every participant must end up with the same document. The page walks through an editing algorithm (operational transformation), a two-way transport (WebSockets) and spreading both across many servers.

## Explained
<!--meta block=explain-->

Google Docs keeps one server in charge of each document. Every editor's connection lands on that server, which puts all edits in one order, rewrites each edit to fit the edits ahead of it (operational transformation), saves it to a log and passes it on, so every screen ends with the same text. The cap of 100 editors per document means no single document is busy; the hard part is the number of open connections, not the edit rate. Choose this over letting edits merge in any order (a conflict-free replicated data type, which gives every character a permanent id) when you already need a central server and no offline editing, because the merge-anywhere design adds memory that grows for ever.

- **Double logic.** Your own keystroke must show before the server answers, so the same rewrite also runs in the browser.
- **Moving documents.** Adding a server moves documents and reconnects editors, so spread documents with a hash ring to move only a slice.
- **Growing log.** A log that grows for ever slows every new joiner, so compact old edits into one.

**Example.** Five million editors hold open connections, 20,000 per server, so you need 250 servers. One document has 100 editors at 3 edits a second each, which is 300 a second, easy for its one owner. You type at position 4 and see it at once. Meanwhile a colleague's 3-character insert at position 0 reached the server first. The server shifts your edit to position 7, then sends it on, so both screens agree. The cost shows up if that document reaches 2 million logged edits: each new joiner replays all of them until compaction collapses the log into one insert.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Create a new document and get back an id.
2. Many users edit one document concurrently.
3. Each user sees the others' changes in real time.
4. Each user sees the others' cursor positions and presence.

Out of scope: rich document structure (assume a plain text editor), access control and sharing levels, and version history — named explicitly so the design stays on the collaboration core.

### Non-functional
<!--meta requirement=nfr-->

- **Convergence** — [eventual consistency](../themes/consistency-and-replication.md): after a burst of edits, all clients settle on identical text.
- **Latency** — a remote edit is visible in under 100&nbsp;ms.
- **Durability & availability** — an acknowledged edit survives server restarts; documents stay reachable.
- **Scale** — millions of concurrent editors across billions of documents, but a hard cap of 100 concurrent editors per document (beyond it, new arrivals join read-only).

The cap bounds write rate per document (100 editors at 3 edits/s is 300 ops/s), not fan-out: each edit goes to up to 99 sockets, about 30,000 messages/s, and read-only viewers past the cap add more. Scaling is about document and socket counts.

## Right-sizing
<!--meta block=sizing-->

**Connections, not edits, set the shape.** A single document is capped at 100 live editors, and even if each fires a few operations a second while actively typing, that is only a few hundred ops/sec per document — trivial for one server. The number that hurts is the fleet total: millions of concurrent WebSocket connections held open at once. At 20,000 connections per server, 5 million connections is 250 servers before any document is even busy, so no single server can own every document.

**Storage grows with history, not size.** The design stores edit operations, not document snapshots. Round a document to ~50&nbsp;KB of retained operations; that is about **50&nbsp;TB** per billion documents — a modest total. The sharp edge is a single long-lived document accumulating millions of operations: replaying all of them to every fresh joiner, and holding them in server memory, is the cost that bites, and it only grows.

**Latency forbids the round trip.** Under-100&nbsp;ms visibility means a user cannot wait for a durable write to be acknowledged before seeing their own keystroke. Local edits must be applied optimistically and reconciled afterward — which is exactly why the same transform algorithm has to run on the client, not just the server.

## Core entities
<!--meta block=entities-->

Four entities, and a deliberate split between what is persisted and what is ephemeral:

- **Document** — the text, plus lightweight metadata (title, and later the version marker used by compaction). Content and metadata are stored separately so permissions, tags, or history can bolt onto metadata later without touching the operation stream.
- **Editor** — a user with an open connection to a document. Identity lives elsewhere; here an editor is really just a socket and a cursor.
- **Edit (Operation)** — one change: an `insert` or `delete` at a position. Operations are the durable unit of truth; the document text is what you get by applying them in order.
- **Cursor** — an editor's position, which doubles as presence. Purely ephemeral: scoped to the live connection and never written to the document store.

## The interface
<!--meta block=interface-->

Two surfaces with two very different jobs. Document management is ordinary representational state transfer (REST); the live editing session is a WebSocket, so the contract that matters is the message protocol over the socket, not a list of HTTP verbs.

```http summary="REST for management, WebSocket protocol for editing"
POST /docs
{ "title": "Q3 planning" }
→ 200 { "docId": "d_9f2a" }

WS  /docs/{docId}          # one long-lived bidirectional connection

# client → server
SEND { "type": "insert",       "pos": 5, "text": ", world" }
SEND { "type": "delete",       "pos": 5, "len": 1 }
SEND { "type": "updateCursor", "pos": 12 }

# server → client
RECV { "type": "update", "op": { … } }   # a transformed peer edit to apply
RECV { "type": "presence", … }           # cursors joining, moving, leaving
```

The document is created once over REST; from then on every keystroke, every cursor move, and every change from a collaborator travels as a small typed message on the open socket.

## How the system is built
<!--meta block=architecture-->

Creation is the boring half: a horizontally-scaled CRUD (create, read, update, delete) service behind an [API gateway](../patterns/distributed/routing/api-gateway.md) writes document metadata to Postgres and hands back an id. The interesting half is the **Document Service**. For a given document, every editor's socket lands on the same instance of it — that instance owns the document while it is live, holds a `documentId → sockets` map, and is the single point that decides the final order of operations. Each incoming edit is transformed against the edits already applied, appended to the operations store, and only then broadcast to the other sockets and acknowledged to its author. The operations store is Cassandra: append-only writes, partitioned by `documentId` and ordered by a server-assigned timestamp, so the log is the document and the text is a projection of it — the [event-sourcing](../patterns/architecture/event-sourcing.md) shape at the heart of the design.

```mermaid caption="Creation flows through the gateway to Postgres; editing rides a WebSocket to the one Document Service that owns the document, which orders edits, logs them to Cassandra, and fans them out. Compaction trims the log in the background."
flowchart TB
    Client["Editor in browser"]
    Gateway["API Gateway"]
    Meta["Document Metadata Service"]
    MetaDB[("Metadata DB — Postgres")]
    Ring["Consistent hash ring — ZooKeeper"]
    Doc["Document Service — owns doc, runs OT"]
    Ops[("Operations DB — Cassandra")]
    Compact["Compaction Service"]
    Client -->|"POST /docs"| Gateway
    Gateway -->|"create doc"| Meta
    Meta -->|"write metadata"| MetaDB
    Client -->|"WS /docs/id"| Doc
    Doc -->|"which server owns this doc?"| Ring
    Doc -->|"append transformed ops"| Ops
    Doc -.->|"broadcast update"| Client
    Compact -->|"read + collapse ops"| Ops
    Compact -.->|"ask owner to publish new version"| Doc
    Doc -.->|"flip version marker"| Meta
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Making concurrent edits converge

The core question: given two edits made against the same starting text but in ignorance of each other, how do all clients end up with the same result? Three answers, in ascending correctness.

- **Send snapshots — wrong.** Each edit ships the whole document, last write wins. Two problems: transferring hundreds of KB per keystroke is absurd, and worse, concurrent edits clobber each other. Start with "Hello!"; A appends ", world" while B deletes "!"; whichever request lands second overwrites the other, and one person's change vanishes silently.
- **Send edits — warmer, still wrong.** Transmit only operations: `INSERT(5, ", world")`, `DELETE(5)`. Far cheaper, but positions are relative to a document state. If B's `DELETE(5)` (meant for "!") arrives after A's insert has shifted everything right, it deletes the comma instead. Each edit is implicitly tied to the context it was made in.
- **Operational transformation — right.** Reinterpret each incoming edit against the edits that already applied before it. One server establishes the canonical order; B's `DELETE(5)` is transformed to `DELETE(12)` once A's insert is in front of it, so it still removes the exclamation mark. Low memory per character, but the operation log still grows until compaction, and it requires a central authority for ordering, which is precisely why a document is pinned to one server.

The alternative worth naming is a **CRDT**: make every operation commutative so order stops mattering and no central server is needed. Text CRDTs (conflict-free replicated data types) give each character a unique, infinitely-subdividable position id and keep deleted characters as hidden tombstones, so any merge order converges. That buys peer-to-peer and offline editing (Yjs is the well-known open-source implementation), but it pays in memory — the document keeps every deleted character as a tombstone, so it keeps growing. With a central server already in the design and a 100-editor cap, operational transformation is the lighter, better-fitting choice; CRDTs are the answer if the requirement shifts to peer-to-peer or heavy offline use.

Two edits against the same text show why the server must transform one of them.

```mermaid caption="How does a delete made in ignorance of a concurrent insert still remove the right character?"
sequenceDiagram
    autonumber
    participant A as Editor A
    participant B as Editor B
    participant S as Document Service
    A->>S: INSERT(5, ", world")
    B->>S: DELETE(5), meant for the exclamation mark
    S->>S: apply insert first, set canonical order
    S->>S: transform DELETE(5) to DELETE(12)
    S-->>A: DELETE(12)
    S-->>B: INSERT(5, ", world")
```

### 2 · Real-time delivery and optimistic editing

Two read paths hang off the socket. On **connect**, the owning server replays the document's operations so the new client starts from the shared state. On every **successful edit**, the server pushes the transformed operation to every other connected client — a straight [fan-out](../patterns/messaging/fan-out.md) that is trivial precisely because all of a document's sockets live on one server. The 100&nbsp;ms budget then forces the subtle part: a user's own keystroke is applied to their local view immediately, before any server round trip — an [optimistic](../patterns/distributed/coordination/optimistic-concurrency-control.md) local write. When a remote edit arrives that was created against an earlier state, the same transform logic runs on the client to reconcile the differing local orderings (server sees `Ea, Eb`; A applied `Ea, Eb`; B applied `Eb, Ea`) so everyone still converges. Cursors ride the same socket but never touch the store: the server holds presence in memory, broadcasts moves, and on socket disconnect drops the departed editor and tells the rest.

### 3 · Scaling to millions of sockets

One Document Service instance is both a bottleneck and a single point of failure. The constraint that makes this tricky is that all sockets for a document must converge on one owner — they cannot be sprayed across the fleet by a plain [load balancer](../patterns/distributed/routing/load-balancer.md). The answer is a [consistent hash ring](../patterns/distributed/routing/consistent-hashing.md): each server owns a range of the hash space, ZooKeeper holds the ring configuration and coordinates membership, and `hash(documentId)` picks the owner. A client opens a plain HTTP connection to any server; if that server does not own the document's hash range it replies with a redirect to the one that does; the client connects there directly, the connection upgrades to a WebSocket, and that owner loads the operations and starts serving — a [document-pinned session](../patterns/distributed/routing/sticky-session.md) where every collaborator on one document deterministically shares a server. Consistent hashing keeps churn small: adding or removing a server reshuffles only a slice of documents rather than all of them. The cost is that a scaling event is not free — displaced sockets must be dropped and reconnected, and the moving document's operations must migrate to the new owner, so clients need reconnect-with-backoff logic and you must watch for hot documents.

When an owner dies, its sockets drop and ZooKeeper membership shows the loss. The ring assigns each of its documents to a new owner, which reloads the log from Cassandra, and the clients reconnect. The risk is split-brain: a stale ring view can leave two owners for one document, so the log write must be fenced, for example by a per-document epoch that the store rejects when it is out of date. How fast the loss is detected is an open gap, and this page gives no number.

```mermaid caption="How does every editor of one document land on the single server that owns and orders it?"
sequenceDiagram
    autonumber
    participant C as Client
    participant A as Any server
    participant O as Owner server
    participant DB as Ops store
    C->>A: HTTP connect for docId
    alt A owns the hash range for docId
        A->>DB: load operations
        DB-->>A: op log
        A-->>C: upgrade to WebSocket, replay ops
    else A is not the owner
        A-->>C: redirect to owner
        C->>O: connect, upgrade to WebSocket
        O->>DB: load operations
        DB-->>O: op log
        O-->>C: replay ops, session live
    end
```

### 4 · Keeping storage and memory bounded

Every operation lives forever by default, and a hot document can reach millions of them — expensive to replay to each new joiner and a memory drain while loaded. The fix is **compaction**: periodically collapse a long run of operations into a tiny equivalent one (ideally a single insert of the current text), which is really a [materialized view](../patterns/distributed/coordination/materialized-view.md) of the operation log. Doing it safely is the interesting part, because Cassandra only offers row-level transactions while a document spans many rows. The trick is a `documentVersionId` on the metadata record: clients read the current version before loading operations, so they always fetch a consistent set, and only the Document Service is allowed to flip the pointer from the old version to the new one. An offline compaction service can read, collapse, and write a new version, then ask the Document Service to flip — but it must skip documents that are live to avoid corrupting in-flight edits, and throttle itself so it does not become its own load problem. The cleaner online variant lets the owning server compact its own documents, and the natural trigger is the moment the last editor disconnects: the operations are already in memory and nobody else holds the document, so it hands them to a low-priority background process, writes the new version, and flips — isolating the work so it never inflates the tail latency of live edits.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Concurrent edits converge once the owner has ordered them and the transform is correct, and optimistic local application keeps typing feeling instant under the 100&nbsp;ms budget.
- Pinning a document to one server makes ordering and broadcast local and cheap, and consistent hashing keeps rebalancing incremental.
- An append-only operation log gives durability and a natural audit trail; compaction stops it from growing without bound.

### What it gives up
<!--meta polarity=con-->

- Operational transformation needs a central ordering server, which rules out true peer-to-peer or rich offline editing — the CRDT territory.
- A scaling event is disruptive: sockets are force-reconnected and a document's operations must migrate to the new owner.
- Cross-store atomicity leans on a hand-managed `documentVersionId` because the operations store lacks multi-row transactions — orchestration that hides subtle races.
- A crashed owner drops its sockets, and its documents reconnect and replay the log on a new owner; the page leaves detection time open.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — likely not asked this one, but if so: a working high-level design and, with some nudging, reasoning through why sending whole snapshots fails and why concurrent edits are hard. Thinking on your feet counts more than knowing the algorithm.
- **Senior** — grasps the consistency and durability challenges quickly, may open with a naïve approach but proactively finds and fixes the bottleneck, and argues database trade-offs (why Postgres for metadata, why an append-only store for operations) even without knowing the OT-vs-CRDT distinction by name. Time for one deep dive.
- **Staff+** — commands the whole problem: at least loosely fluent in CRDTs (or works them out live), and intimately comfortable with scaling socket services, ordering and serialization, transaction limits, and the compaction/versioning story. Gets through the deep dives and adds one — read-only mode at scale, offline sync, or memory optimization.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Event Sourcing](../patterns/architecture/event-sourcing.md) — the append-only operation log is the source of truth and the visible text is a projection replayed from it
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — a user's own keystroke is applied to their local view before any server round trip, then reconciled via transform when the authoritative order arrives
- [Fan-Out](../patterns/messaging/fan-out.md) — once an edit is ordered and logged, the owning server broadcasts it to every other socket on that document
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — documents are assigned to owning Document Service instances via a ZooKeeper-backed hash ring so adding or removing a server reshuffles only a slice
- [Sticky Session](../patterns/distributed/routing/sticky-session.md) — every WebSocket for one document is pinned to the single server that owns and orders that document
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — compaction collapses a document's long operation history into a precomputed snapshot under a new version marker
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — A create, read, update, delete (CRUD) service behind an application programming interface (API) gateway creates document metadata and hands back an id before editing starts
- [WebSocket](../patterns/messaging/websocket.md) — Every editing socket stays open to the document's owning server, so each keystroke goes out and each peer's edit comes back with no polling.

<!-- relationships:end -->
