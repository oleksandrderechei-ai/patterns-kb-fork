---
title: Actor Model
description: Isolated actors that only communicate via messages
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, isolation, encapsulation]
status: stable
solves: [every variable my threads share needs a lock and I keep forgetting one somewhere, my deadlock appears only under load because several locks are taken in different orders, one component crashing corrupts state and takes the whole process down with it, I need to model hundreds of thousands of stateful entities and a thread each is way too expensive, spreading my components across machines means rewriting how they talk to each other]
---

# Actor Model

Each unit of computation is an isolated actor with private state and a mailbox — it handles one message at a time and reaches every other actor only by sending one, never by touching its memory directly.

## What it is
<!--meta block=description-->

Threads and locks need a lock per shared variable and one lock order across the whole codebase, and a mistake shows up only under load. An actor owns private data and a mailbox of messages and handles one message at a time. No other actor touches its data, so nothing is shared and nothing needs a lock.

## Explained
<!--meta block=explain-->

An actor is a small unit that owns private data and a mailbox, a queue of messages sent to it. It handles one message at a time, and in reply it may send messages, create new actors or choose how it handles the next message. No other actor touches its data, so two threads never change the same value and you need no locks. Carl Hewitt introduced the model in 1973, and Erlang made it a production discipline. Choose it over threads plus locks when you have many independent stateful things, such as user sessions or devices, whose failures should stay local: a supervisor, an actor that watches its children, restarts a crashed one. A send looks like a network call, so the same program runs in one process or a cluster. For stateless bulk work use a thread pool, and for a rule across actors use a saga, a chain of steps with undo actions.

- **Message order is weak.** Order across three parties is not guaranteed, and a retry or redelivery can repeat one, so make handlers order-tolerant and idempotent.
- **Causes spread over mailboxes.** Copy a correlation ID into every message from the first one.
- **A slow handler stalls its mailbox.** Keep handlers short and give blocking work its own threads.
- **Unbounded mailboxes.** They end in an out-of-memory kill, so bound every mailbox that takes outside input.

**Example.** A chat server keeps one actor per room, so 10,000 rooms are 10,000 mailboxes. Each handler takes 1 ms, so a room clears 1,000 messages a second. A hot room receives 3,000 a second, so its mailbox grows by 2,000 a second. At 200 bytes a message that is 400 KB a second, about 1.4 GB an hour, until the process hits its memory limit and is killed, and every room goes down with it. With a mailbox bound of 5,000, the hot room fills in 2.5 s and senders are told to slow down, so the damage stays in that room. The cost is that the hot room delays or refuses messages, and senders must cope.

## How it works
<!--meta block=structure-->

```mermaid caption="How do two units of work avoid scribbling over each other's data? Nothing outside the box reaches the state at step 3 — the only way in is a message dropped in the mailbox at step 1, and step 2 hands those over one at a time, so there is no lock to take."
flowchart LR
    S["Sender actor"]
    subgraph A["One actor — state nothing outside can touch"]
        MB[("Mailbox")]
        Loop["Handler, one message at a time"]
        St[("Its own state")]
    end
    Other["Another actor"]
    Child["A child it spawns"]
    S -->|"1 send a message"| MB
    MB -->|"2 hand over the next one, in turn"| Loop
    Loop -->|"3 read and update"| St
    Loop -->|"4 send onward"| Other
    Loop -->|"5 spawn a child, or change what it does next"| Child
```

## Variations
<!--meta block=variations-->

- **Classical actors (Hewitt/Agha)** — The original formalism — pure message passing, no shared state, every send asynchronous and non-blocking. Every other flavor below specializes this baseline.
- **Erlang/OTP processes** — Lightweight BEAM processes with no shared heap, linked into supervision trees that restart a crashed process instead of trying to keep it alive — the "let it crash" philosophy.
- **[Immutability](../functional/immutability.md) of messages** — Messages are immutable values or copies, never shared, so even two actors in one process cannot alias each other's state through a message. Copying large messages has a cost.
- **[Message Queue](../messaging/message-queue.md)-backed mailboxes** — Back the mailbox with a durable, external broker instead of an in-memory list, so messages survive an actor restart or a node failure and can be replayed.
- **[Backpressure](./backpressure.md)** — Bound the mailbox and block, drop, or signal the sender once it's full, so a slow actor pushes back on load instead of growing its queue until memory runs out.
- **Virtual actors (Orleans grains)** — The runtime activates an actor on its first message and deactivates it when idle; you address a logical identity and never place or reap an instance by hand. Location stays transparent to the caller, but the placement policy itself is a knob — random, prefer-local, load-aware, or your own — so locality and hot-actor spread are tunable when they start to matter.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **No shared mutable state** inside an actor to lock, so classic data races are structurally impossible there.
- **The same code runs** in one process or across a cluster, because a send already is the network boundary; handlers must still tolerate remote latency, loss and duplicates.
- **A crashed actor's damage stays local**, so a supervisor can restart it without corrupting anyone else's state.
- **Scales down to a handful of actors** on one core and up to very many lightweight processes in runtimes built for it, such as Erlang's BEAM.

### Cons
<!--meta polarity=con-->

- **No shared state doesn't mean no race conditions** — message order between two actors isn't guaranteed relative to a third, and stale-state bugs just move to the message layer.
- **Debugging trades a linear call stack** for causality scattered across mailboxes and logs, which is harder to step through.
- **A message handler that blocks** or runs long stalls every message queued behind it in that actor's mailbox.
- **Unbounded mailboxes can hide an overload problem** until memory runs out — needs deliberate backpressure design.
- **A send can be lost** with no error and no ack; reliable delivery means acks, retries and deduplication you build yourself.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need many concurrent units** with private state and no safe way to share it.
- **The same logic should run identically** on one machine or distributed across many.
- **Failures must stay isolated** — one bad actor shouldn't corrupt or block the rest of the system.
- **You're modeling many independent**, stateful entities with their own lifecycle — sessions, devices, game entities.

### Avoid when
<!--meta polarity=avoid-->

- **The work is stateless and data-parallel** — a plain [thread pool](./thread-pool.md) or a [Future / Promise](./future-promise.md) pipeline is simpler and cheaper.
- **A caller needs a direct**, synchronous result — a plain function call beats a message round-trip.
- **Cross-actor invariants need real transactions** — actors buy you isolation, not distributed consistency.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal actor with a mailbox"
type Message = { type: string; payload?: unknown };

abstract class Actor {
  // unbounded here; a real mailbox needs a bound and an overflow policy
  private mailbox: Message[] = [];
  private draining = false;

  send(msg: Message): void {
    this.mailbox.push(msg);
    this.drain(); // wake the loop if it's idle
  }

  protected abstract receive(msg: Message): Promise<void>;

  private async drain(): Promise<void> {
    if (this.draining) return;         // already processing
    this.draining = true;
    try {
      while (this.mailbox.length > 0) {
        await this.receive(this.mailbox.shift()!); // one message at a time
      }
    } catch (err) {
      console.error("receive failed; a supervisor would restart here", err);
    } finally {
      this.draining = false; // a throw no longer wedges the actor
    }
  }
}

class Counter extends Actor {
  private count = 0;
  protected async receive(msg: Message): Promise<void> {
    if (msg.type === "increment") this.count++;
    if (msg.type === "read") console.log(this.count);
  }
}
```

## In the wild
<!--meta block=wild-->

- **Erlang/OTP** — BEAM processes are share-nothing actors, and Open Telecom Platform (OTP) supervision trees restart a crashed one instead of defending against every failure in-line. The supervisor exposes the knobs directly — one_for_one vs. rest_for_one restart strategies and a restart-intensity cap that escalates a crash loop up the tree — and the scheduler preempts processes on a reduction budget, so no single actor can hog a core. {#wild-erlang-otp}
- **Akka** — Brought Erlang-style actors, supervision, and location transparency to the Java virtual machine (JVM), with clustering that lets the same actor code span nodes. Dispatchers and mailbox types are swap-in configuration rather than code — the standard operational move is giving blocking work its own dispatcher so it cannot starve the default one — and Cluster Sharding spreads entity actors across nodes while passivating the idle ones. {#wild-akka}
- **Microsoft Orleans** — Its virtual actors (grains) are activated on first message and deactivated when idle, so placement and lifecycle stay the runtime's problem. A grain processes one request at a time unless explicitly marked reentrant, and the idle-deactivation age is a configurable dial — operators tune how long a silent grain holds memory rather than where it lives. {#wild-orleans}
- **Akka.NET** — The .NET port of the same actor runtime: hierarchical supervision, location-transparent actor references, and cluster sharding that distributes actors across nodes by identity. {#wild-akka-net}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **mailbox capacity and overflow policy** — most runtimes default to unbounded; bounding forces a choice — block the sender, drop, or signal — and that choice is your backpressure design
- **supervision strategy** — restart just the crashed actor or its whole sibling group, and how many restarts within what window before escalating — the cap is what turns a crash loop into a visible failure instead of an infinite one
- **request-reply timeout** — every ask/call over messages needs an explicit deadline; the runtime's default (or its absence) was not chosen for your workload
- **dispatcher allotment** — how many carrier threads run the actors and how much work one actor does before yielding; blocking work needs its own dispatcher so it cannot starve everyone sharing the default
- **idle passivation age** — in virtual-actor runtimes, how long an idle actor stays in memory before deactivation — too short thrashes activation, too long hoards memory for entities nobody is talking to

### Signals to watch
<!--meta polarity=signal-->

- **per-actor mailbox depth** — aggregate throughput hides the one hot mailbox that is the actual bottleneck; watch the max, not the mean
- **message age at dequeue** — time from enqueue to processing — the latency senders actually experience, invisible in handler execution time
- **restart rate** — supervisor restarts should be rare events; a steady rate means a poison message or a dependency that is down
- **dead-letter volume** — messages sent to stopped or nonexistent actors — a rising count usually means lifecycle bugs, not lost mail

### Failure modes under load
<!--meta polarity=failure-->

- **hot-actor serialization** — one actor owns the popular entity and processes strictly one message at a time — throughput for that entity is capped at one mailbox's rate; unrelated actors are unaffected unless they wait on it
- **poison-message restart storm** — a malformed message crashes the handler, the supervisor restarts the actor, the message or its sender retries — a tight loop that burns CPU and floods logs until the intensity cap trips
- **unbounded mailbox growth** — a slow actor fed by fast producers grows its queue silently; the failure surfaces as an out-of-memory kill far from the actor that caused it
- **blocking on the shared dispatcher** — one handler making a synchronous I/O call parks a carrier thread; enough of them and every actor on that dispatcher stops, not just the guilty one

### Readiness checklist
<!--meta polarity=check-->

- bound the mailboxes fed by external input, and decide the overflow behavior before load decides it for you
- keep handlers non-blocking; give unavoidable blocking work its own dispatcher or pool
- make handlers idempotent or park poison messages aside: senders that retry, or durable mailboxes that redeliver, can deliver a message twice
- monitor per-actor mailbox depth and message age, not just aggregate throughput
- put an explicit timeout on every request-reply interaction and test the timeout path

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Isolated actors that share nothing and communicate only by messages. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Message Queue](../messaging/message-queue.md) — Each actor has a mailbox queue
- [Backpressure](./backpressure.md) — Bounded mailboxes push back
- [Immutability](../functional/immutability.md) — No shared mutable state to guard
- [Channels](./channels.md) — The actor model adds addresses and supervision over the mailbox

**Alternative to**

- [Monitor Object](./monitor-object.md) — Message-passing vs. shared-state locking
- [Active Object](./active-object.md) — An actor addresses untyped messages to a mailbox and adds supervision and distribution

**Specializes**

- [Thread Confinement](./thread-confinement.md) — An actor is confinement made concrete — one thread owns the state, messages are the only way in

**Prevents**

- [Deadlock](../../hazards/deadlock.md) — Removes lock-ordering deadlocks: no shared locks to take. A cycle of request-reply waits can still stall actors, so put a timeout on every ask

**Demonstrated by**

- [Online Chess](../../designs/online-chess.md) — a chess game is a textbook actor — private in-memory state mutated by a serial mailbox of moves, which is why platforms run it on cluster sharding
- [WhatsApp](../../designs/whatsapp.md) — The design leans on actors as the reason a small team could serve billions of messages a day

**Implemented by**

- [Compute](../../capabilities/compute.md) — Only Azure sells this ready-made, as durable entities; elsewhere you run an actor framework such as Orleans, Dapr or Akka.

<!-- relationships:end -->
