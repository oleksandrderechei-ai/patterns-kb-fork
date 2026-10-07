---
title: Online Chess
description: "Match players by rating, run 500K real-time games where the server owns every board and clock, and rank 10M players live"
area: designs-advanced
owner: Oleksandr Derechei
tags: [concurrency, state-management, latency, validation]
status: stable
aliases: [Chess.com, Lichess, multiplayer chess]
solves: [two workers both claim the same waiting player and double-book them into two matches, keeping live session state in a shared store makes every action pay a network round trip, a server that holds in-memory sessions crashes and takes every one of them down with it, a distant player keeps losing on the clock because their own network lag comes out of their own time, showing someone their exact rank means counting millions of rows above them on every request]
---

# Online Chess

An online chess platform is three systems wearing one coat: skill-based matchmaking that pairs strangers by rating, a real-time game in which the server is the sole authority on the board and both clocks, and a global leaderboard. The whole design turns on one rule — the server validates every move and owns the time — and on holding half a million live games in memory without losing one to a crash.

## Understanding the problem
<!--meta block=description-->

Two players are paired by rating, play with their own countdown clocks, and afterwards climb a rating ladder. The hard part is authority: the server validates each move and owns both clocks, so no client plays an illegal move, claims extra time or sees a different board. The page builds the single game first, then scale, clock fairness and survival of the game-server fleet.

## Explained
<!--meta block=explain-->

Online chess keeps each live game in the memory of one server, so that server checks every move and runs both clocks without a trip to a database. It appends each accepted move to a durable log before telling anyone, so the log is the truth and the board is a copy built from it. Choose this over a stateless design that loads the game from a shared store on every move, because that extra hop eats the 200 ms budget. Matchmaking claims a waiting player with one atomic remove from a Redis sorted set (a list ordered by rating), so exactly one matcher wins.

- **Crashes.** A crash takes down that server's games, so a replacement replays the short move log to rebuild the board.
- **Zombie servers.** A replaced server may keep writing, so each reassignment bumps a counter and writes with an old counter fail.
- **Lag unfairness.** Distant players lose time in transit, so credit back half the measured round trip, capped near 100 ms a move.

**Example.** With 500,000 games running there are 1 million open connections. A player 170 ms slower per move than the opponent loses about 170 ms times 40 moves, 6.8 s of a blitz clock, just for living far away; lag compensation gives back up to about 100 ms of each move's 170 ms. A server dies after move 40. The new server reads the clocks, replays the 40 logged moves, a few hundred bytes, and carries on. The old server wakes and writes move 41 with a stale counter, and the database refuses it. The cost is a short pause for the players.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Find an opponent of similar skill through matchmaking and start a game.
2. Play the game in real time, with the server validating every move and running both clocks.
3. View a global [leaderboard](./top-k.md) and one's own rank, both refreshed shortly after a game ends.

Out of scope: spectating and broadcasts, chat and social, puzzles and post-game analysis, tournaments, and anti-cheat/engine-detection — named so the core stays narrow (several are revisited as deferred systems below the line).

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — move propagation end to end under 200&nbsp;ms.
- **Consistency over availability** — if a game server is unreachable, pause the game rather than let two clients diverge. A paused game is recoverable; a corrupted one is not.
- **Fair clock** — a player's own network latency must not systematically eat their own time.
- **Scale** — 500K concurrent games at peak, which is 1M live connections plus 500K stateful game sessions.

## Right-sizing
<!--meta block=sizing-->

**Connections.** 500K games × 2 players ≈ **1M concurrent WebSocket connections**, each also carrying live in-memory state (board, whose turn, two clocks). A box holds tens of thousands of idle sockets, but a game server also validates moves and runs clocks, so realistic per-node counts are lower — the fleet lands at dozens to low hundreds of servers.

**Matchmaking throughput.** Blitz games last a couple of minutes and players immediately re-queue, so ~1M active players ÷ ~120&nbsp;s ≈ **8k match requests/sec** from re-queuing alone; fresh arrivals and evening peaks push it to **tens of thousands/sec**. Each request is a range search plus an atomic claim against one shared pool — the contention, not the compute, is the problem.

**Leaderboard.** Around 10M rated players. The whole ranking structure is roughly a gigabyte, and games finish at ~4k/sec × 2 players ≈ **8k rating updates/sec** — comfortable for a single node. The hard part is not the write rate but answering one player's exact rank out of 10M on the most common personalized read on the site.

## Core entities
<!--meta block=entities-->

Four entities, with matchmaking kept separate from gameplay on purpose:

- **Player** — identity plus a skill `rating` (ELO). The rating drives both matchmaking and leaderboard placement, and is always read from this record server-side, never trusted from a request body.
- **Game** — one game between two players: colour assignment, current board position, whose turn, both clock values, the pre-game ratings snapshotted for the ELO delta, a `generation` fence, and the result once over.
- **Move** — one move (`from`, `to`, `moveNumber`, `timestamp`). Moves form an append-only history — the durable record the whole design leans on for recovery.
- **MatchRequest** — a pending request to be paired, carrying rating and preferred time control (e.g. "3 minutes each, +2 s/move"). Kept apart from Game so matchmaking has its own record to churn against.

## The interface
<!--meta block=interface-->

Matchmaking and the leaderboard are request/response representational state transfer (REST); gameplay is a persistent WebSocket, because both sides continuously send and receive. The security line to hold: `playerId` and `rating` come from the auth token, never the request body — a client that could name its own rating would shop for an easier opponent.

```http summary="Protocol — REST for setup, WebSocket for play"
POST /matchmaking            → MatchRequest    # async pairing, held open as a long-poll
Body: { timeControl }        # e.g. "blitz-3-2" = 3 min each, +2 s/move
# playerId + rating are read from the auth token, never the body

WS /games/:gameId            # gameplay rides one persistent socket, not polling
  client → server:  sendMove     { from, to, moveNumber }
  server → client:  moveAck      { accepted, reason?, whiteTimeMs, blackTimeMs }
                     opponentMove { from, to, whiteTimeMs, blackTimeMs }
                     gameEnd      { result }

GET /leaderboard?cursor=&limit=   → Player[]           # top-N page, cursor-paginated
GET /players/:id/rank             → { rank, rating }   # the expensive personalized read
```

The matchmaking `POST` is a **long-poll**: it stays open until the player is paired or times out, so both the arriving player and the one already waiting get their answer on the same held request — no separate notification channel to the client is needed.

## How the system is built
<!--meta block=architecture-->

Three planes, loosely joined. The **Matchmaking Service** keeps a pending pool in Redis (one sorted set per time control) and, on a pairing, creates the Game and notifies both players over a Redis channel. A thin, stateless **Session Router** maps each `gameId` to a **Game Server** through a hash ring and a membership registry, so both players land on the same server; that server holds the board in memory, validates moves locally, and appends every move to a durable log before it broadcasts. When a game ends it computes new ratings and updates the **Leaderboard**, a Redis sorted set kept as a rank index built from the durable Games record, and rebuildable from it.

```mermaid caption="Setup is REST and Redis; play is a socket to one stateful server; every move is durable before it is seen; ratings flow into a rebuildable rank index."
flowchart TB
    Client["Player · browser"]
    MM["Matchmaking Service"]
    Redis[("Redis · sorted set + pub/sub")]
    Router["Session Router · hash ring"]
    Registry[("Membership Registry")]
    Game["Game Server · board in memory"]
    Log[("Move log + Games DB")]
    Board[("Leaderboard · sorted set")]

    Client -->|"POST /matchmaking (long-poll)"| MM
    MM -->|"ZADD / ZRANGEBYSCORE / ZREM"| Redis
    Redis -->|"matchFound"| MM
    Client -->|"WS /games/:id"| Router
    Router -->|"watch membership"| Registry
    Router -->|"route both seats"| Game
    Game -->|"append move, then broadcast"| Log
    Game -->|"on game end: new ELO"| Board
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Where does the live game live?

The core decision is whether game state (board, turn, clocks) sits in a shared store or in a server's memory.

- **Stateless servers, state in a shared store.** Any server can handle any move: load the game from Redis/DB, validate, write back, broadcast. There is no routing problem and a dying server loses nothing — but every move now pays a network round trip inside the 200&nbsp;ms budget, trading a microsecond in-memory check for a hop, and the store must be kept hot for every active game.
- **Stateful servers, board in memory (chosen).** Each game is owned by one server that holds its board and clocks in memory and validates moves with nothing to fetch. Like an [actor](../patterns/concurrency/actor-model.md), it has one owner and one queue of moves, handled in order. A chess game is a few hundred bytes and lasts minutes, so it is cheap to hold; in-memory validation stays inside the latency budget. The cost is that both players must land on the same server and a crash takes its in-flight games down.

Durability is bought cheaply and separately. Every accepted move is appended to a durable log **before** the server broadcasts it — a [write-ahead log](../patterns/distributed/coordination/write-ahead-log.md) ordering. If the server acked and pushed first and then crashed, recovery would produce a board missing a move both players already saw: the exact corrupted state the "pause, don't corrupt" rule forbids. The 200&nbsp;ms budget easily absorbs a few-millisecond synchronous write. And because the log is the truth, the in-memory board is just its fast projection — this is [event sourcing](../patterns/architecture/event-sourcing.md): a replacement server rebuilds the board by replaying a few hundred bytes of moves, so no snapshot or checkpoint machinery is ever needed.

### 2 · Matching fairly at scale

Tens of thousands of match requests per second hit one pending pool, and most players cluster around middle ratings where nearly everyone is a compatible opponent — so the same waiting players are candidates for huge numbers of simultaneous incoming requests. Two matchers reading the same waiting player and both pairing them is a [race condition](../hazards/race-condition.md) that double-books someone into two games. The pool moves into a Redis **sorted set** per time control (member = requestId, score = rating): `ZRANGEBYSCORE` finds opponents in a rating window that widens with wait time, and the claim is a single `ZREM` — a return of 1 means this worker won the player, 0 means someone already took them. The matcher also ZREMs its own request; if that returns 0, another matcher already paired it, and the matcher puts the first player back in the pool at the same score. This is [optimistic concurrency](../patterns/distributed/coordination/optimistic-concurrency-control.md): no lock is held, exactly one worker wins the contested claim, and losers retry. The winning worker then publishes `matchFound` on a [pub/sub](../patterns/messaging/pubsub.md) channel keyed by requestId; whichever node holds that player's long-poll is subscribed and completes the request with the gameId. At the sized tens of thousands of requests/sec, one Redis node holds the busiest single time control, so the pool is replicated with automatic failover rather than sharded; pending requests are cheap and ephemeral, so a failed-over pool just refills within seconds.

Two matchers can see the same waiting player; the single ZREM decides who gets them.

```mermaid caption="How do two matchers racing for one waiting player end with exactly one winner?"
sequenceDiagram
    participant M1 as Matcher 1
    participant M2 as Matcher 2
    participant Z as Redis sorted set
    M1->>Z: ZRANGEBYSCORE (rating window)
    M2->>Z: ZRANGEBYSCORE (rating window)
    Z-->>M1: same waiting player
    Z-->>M2: same waiting player
    M1->>Z: ZREM
    Z-->>M1: 1, claim won
    M2->>Z: ZREM
    Z-->>M2: 0, already taken, retry
```

### 3 · Surviving a game-server crash

Routing and survival are one problem. The Session Router maps `gameId` to a server with [consistent hashing](../patterns/distributed/routing/consistent-hashing.md) — each game server holds an ephemeral node in a membership registry (ZooKeeper, etcd, or Consul) that expires when it stops heartbeating, and the router rebuilds its ring on membership change so adding or losing a node remaps only a small slice of games. Recovery is pure replay: the successor loads the Game row for clocks and turn, replays the move log to rebuild the board, and takes over.

The subtle failure is a zombie — a replaced-but-still-alive server on the far side of a partition that keeps writing to a game the ring has moved on from. The fix is a `generation` counter on the Game row, bumped each time the ring reassigns the game; every write, the move-log append included, runs as a [conditional write](../patterns/distributed/coordination/conditional-write.md) guarded by `WHERE generation <= :gen`, so the zombie's stale-generation updates silently fail their predicate and are dropped. A node joining moves a slice of healthy games the same way: the ring reassigns the game, the generation is bumped, and the new owner replays the log. A player who disconnects is handled differently: the clock keeps running, matching over-the-board rules, so nobody escapes a losing position by closing the tab.

### 4 · A fair clock across uneven latency

The server can only start or stop a timer when the move physically arrives, so each player's own transit latency comes out of their own clock. A player 200&nbsp;ms one-way from the server pays ~170&nbsp;ms extra per move over a 30&nbsp;ms one-way opponent — roughly 7 seconds across a 40-move blitz game, enough to lose on time purely for being far away. The clock is exactly the value that must stay server-authoritative, so a client-managed timer is out. The chosen answer keeps the server authoritative but adds **latency compensation**: it measures round-trip time continuously with WebSocket ping/pong frames, keeps a rolling median RTT (to resist spikes), and on each move credits back an estimated one-way transit of `median_rtt / 2` before charging think time. It is best-effort by design — asymmetric paths make it fair only on average, and a client could stall its pong to claw back time, so the compensation any single move can reclaim is capped (~100&nbsp;ms). The goal is to erase the systematic geographic penalty, not to defeat a determined cheater at the margin.

### 5 · Exact rank across 10M players

The top-N page is easy: a btree on `rating` walks the first 50 entries even at 10M rows, behind a cache on a page that barely moves. The hard read is a single player's own rank — `COUNT(*) WHERE rating > :myRating` — because a btree gives sorted order but not position, so it is O(rank), millions of entries for the mid-pack majority, on the most common personalized read on the site. If approximate is acceptable, a few hundred per-band counts give "about 4,200th" in constant time. For exact rank, keep a Redis sorted set of `(playerId, rating)`: `ZREVRANK` is O(log n) because the backing skip list is an order-statistics structure (a structure that keeps counts so it can read off a position) a plain btree is not. Crucially, that sorted set is a [materialized view](../patterns/distributed/coordination/materialized-view.md) (a computed copy), never the source of truth — a rating can be fully worked out from a player's finished games (each stores its pre-game ratings), so the game-end write to the Game row is the single commit point, and the Players row and sorted set are both filled by an idempotent apply (applying it twice has the same effect as once) keyed on `gameId`. A drifted or lost set is simply rebuilt from completed games; there is no precious in-memory rating to protect.

```mermaid caption="How one move is validated, made durable, then broadcast — and in what order."
sequenceDiagram
    autonumber
    participant P1 as Mover
    participant S as Game server, board in memory
    participant Log as Durable move log
    participant P2 as Opponent
    P1->>S: submit move
    alt legal move
        S->>S: validate in memory
        S->>Log: append move before broadcast
        Log-->>S: acked
        S-->>P1: accepted
        S->>P2: broadcast move
    else illegal move
        S--xP1: rejected
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- In-memory move validation stays microseconds, comfortably inside the 200&nbsp;ms move budget.
- Crash recovery is pure replay of a few hundred bytes for a game that lasts minutes, so no snapshots or checkpoint scheme are needed at that length.
- A lock-free atomic claim scales matchmaking to tens of thousands of requests/sec on a single Redis key.
- Exact rank is O(log n) and the whole leaderboard is rebuildable from finished games.

### What it gives up
<!--meta polarity=con-->

- Consistency over availability means a server failure pauses a game and forces a brief reconnect rather than tolerating divergence.
- Latency compensation is fair only on average; the cap limits pong-stall abuse rather than detecting it.
- The hash ring decides placement from the node list alone, so adding servers during a peak moves a slice of healthy running games, each replayed on its new server.
- Anti-cheat/engine-detection, spectator [fan-out](../patterns/messaging/fan-out.md), and the permanent game archive are separate systems deliberately kept off the live path.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design across all three requirements: matchmaking, a server-validated real-time game over WebSocket, and a leaderboard. The load-bearing insight is that the server, not the client, owns move validation and the clock; notices 500K games cannot live on one box, and reaches a "good" answer for one deep dive with some prompting.
- **Senior** — races through the high-level design to spend the time on deep dives, works out the scale numbers unprompted (1M connections, tens of thousands of match requests/sec) and uses them to kill naive options, argues the plain vs. latency-compensated clock trade-off, talks through consistent hashing with a membership registry, and states the consistency-over-availability call out loud.
- **Staff+** — sees that the durable move log is the recovery mechanism, so a replacement server just replays a few hundred bytes and failover needs only a generation fence; resists the over-engineering trap of a snapshot or checkpoint scheme a short game never needs; and goes deep on production realities — draining games on a deploy, what reconnection looks like to the client during failover, and tuning the matchmaking widening policy from real wait-time data.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Actor Model](../patterns/concurrency/actor-model.md) — each live game is owned by one server that holds its board and clocks in memory and processes its own moves serially
- [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) — gameId is mapped to a game server through a hash ring plus a membership registry so both players land together and node changes remap only a slice
- [Write-Ahead Log](../patterns/distributed/coordination/write-ahead-log.md) — every accepted move is appended to a durable log before it is broadcast, so a crash can never leave players ahead of the record
- [Event Sourcing](../patterns/architecture/event-sourcing.md) — a replacement server rebuilds the board by replaying the move log, and a rating is a fold over finished games rather than a stored value
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — two matchers racing for the same waiting player are resolved by an atomic ZREM claim where exactly one wins and losers retry, no lock held
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — a generation counter on the game row guards every write with WHERE generation <= :gen, so a partitioned zombie server's stale updates are silently dropped
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — exact rank is served from a Redis sorted set computed from finished games, never the source of truth and always rebuildable by reconciliation
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — the worker that claims a player publishes matchFound on a channel keyed by requestId to whichever node holds that player's long-poll

<!-- relationships:end -->
