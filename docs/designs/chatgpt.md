---
title: ChatGPT
description: Stream a large language model (LLM) answer token-by-token to 200M users while fairly scheduling a scarce pool of GPUs
area: designs-advanced
owner: Oleksandr Derechei
tags: [performance, latency, throughput, backpressure, resource-management]
status: stable
aliases: [LLM serving, conversational AI]
solves: [my users stare at a blank screen for thirty seconds while the backend computes the whole answer before sending anything, a burst of requests slams my expensive workers all at once and latency spirals instead of degrading gracefully, one heavy user drains my scarce pool of accelerators and everyone else's requests starve, replaying the entire conversation into the model on every turn keeps getting slower and more expensive, a routine deploy kills thousands of in-flight streaming responses mid-sentence]
---

# ChatGPT

A conversational AI serves an LLM's answer to a user's prompt, streaming it token by token and saving each chat so it can be resumed later. The model itself is a black box; the engineering is in the serving layer — pushing tokens out fast, scheduling a scarce pool of GPUs, and keeping cost bounded as conversations grow.

## Understanding the problem
<!--meta block=description-->

A user types a prompt, an answer streams back a few words at a time, and old chats can be reopened and continued. The model is a service we call, so every hard question lands in the serving system. GPUs are the scarce, costly resource, and time to the first token matters more than total time. This page walks through queuing, streaming and context cost.

## Explained
<!--meta block=explain-->

This design streams a model's answer to the browser a few words at a time while sharing a small, costly pool of GPUs (the chips that run the model) among millions of users. Two moves make it work. A queue sits in front of the GPUs, so a burst waits briefly instead of crashing a worker, and each GPU advances many answers by one word per pass, so no pass runs half empty. A live stream of words is kept per request, so any server can pick up a dropped connection and replay what the browser missed. Choose it over a plain call-and-wait design when one answer takes seconds and the GPUs, not the web servers, set your bill. If inference is cheap enough to answer inside one request, the queue and the stream are overhead.

- **Estimated limits.** Answer length is unknown until the end, so let users overshoot slightly and settle the difference afterward.
- **Starved free users.** Strict priority for paid users can starve free ones, so reserve a floor of capacity for them.
- **Lossy summaries.** Summarising old turns drops detail, so keep the recent turns word for word.

**Example.** At peak, 20k prompts arrive each second and each stream stays open about 6 s, so 20k times 6 is 120k answers in flight at once. A user on turn 51 of a chat has 50 earlier turns of about 500 tokens (a token is a word piece), so replaying them would send 25k tokens. The server instead reuses its saved work on those 25k and processes only the new 500. The cost is that the saved work lives in one server's memory, so a different server redoes it. The user closes the tab at second 3; the answer keeps generating, and reopening it replays the missed words from the stream.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Send a prompt in a chat and receive an AI-generated response.
2. View past chats and resume a conversation, with the prior turns carried into the new prompt as context.

Out of scope: editing or branching existing messages; image, audio and video I/O; sharing and collaboration; custom GPTs, tool calling and web browsing; full-text search across history.

### Non-functional
<!--meta requirement=nfr-->

- **Time-to-first-token** — under ~500&nbsp;ms, then smooth continuous streaming; the full answer may take up to ~30&nbsp;s.
- **Availability over consistency** — ~99.9%+, favouring a degraded or errored experience over blocking on perfectly synchronised chat state.
- **Scale under GPU-constrained capacity** — 200M daily actives, ~20k prompts/sec at peak, ~120k concurrent in-flight streams, with fair allocation across a tiered (free vs paid) user base.
- **Durability scope** — only the final assistant message is persisted, not every streamed token.

## Right-sizing
<!--meta block=sizing-->

**Concurrency.** ~20k prompts/sec at peak, each stream held open for ~6&nbsp;s on average — most answers are short, a long one runs to ~30&nbsp;s — lands the system at roughly **120k concurrent in-flight streams** (arrival rate × holding time). That concurrency number — not the request rate — is what the streaming and scheduling design has to hold up.

**GPUs.** A frontier model's weights don't fit on one GPU, so they're split across a whole box of them; holding 120k streams live means standing up thousands of such boxes — **tens of thousands of GPUs** for a single model. As an order-of-magnitude anchor, reported estimates put OpenAI's inference compute in the billions of dollars a year. At this scale, each point of GPU utilization is worth real money, which is why the deep dives work on batching and queueing.

**Context cost.** A 50-turn chat at ~500 tokens/turn ships roughly **25k input tokens** on the next prompt if you replay everything. Since input tokens are billed per call, the naïve "resend the whole history" approach makes each turn slower and more expensive than the last, and eventually blows past the model's context window entirely.

## Core entities
<!--meta block=entities-->

Four entities, the last of which only earns its place once streaming needs a handle:

- **User** — an account carrying a `tier` (free vs paid), which later drives fairness and scheduling.
- **Chat** — one conversation thread belonging to a user; an ordered sequence of messages with a title and timestamps.
- **Message** — a single turn (user prompt or assistant response): `chatId`, `role`, `content`, and a token count.
- **Generation** — one inference attempt for a message: a `runId`, `chatId`, `messageId`, a `status` lifecycle (`queued → streaming → done / cancelled / failed`), the model that served it, and input/output token counts used for billing and quotas.

## The interface
<!--meta block=interface-->

Plain representational state transfer (REST) for the CRUD (create, read, update, delete) surface; the one streamed endpoint is delivered over Server-Sent Events and hands back a `runId` so an in-flight response can be tracked, reconnected to, or cancelled:

```http summary="HTTP — chats, streamed messages, history, cancel"
POST /chats
→ 200 { "chatId": "..." }

POST /chats/{chatId}/messages          # streamed via SSE
{ "content": "..." }
→ 200 Message (token deltas over SSE; response carries a runId)

GET /chats?cursor={c}&limit={n}        # sidebar, cursor-paginated
→ 200 Chat[]
GET /chats/{chatId}/messages?cursor={c}&limit={n}
→ 200 Message[]

POST /chats/{chatId}/runs/{runId}/cancel   # plain HTTP side-channel
→ 202 Accepted
```

Two decisions carry weight here. First, `userId` never appears in a path or body — it comes from the session token, and chat ownership is checked server-side on every request; a client-supplied `userId` can be forged, so the server ignores it. Second, because SSE is a one-directional server→client channel, anything the client needs to send mid-stream — notably "stop generating" — travels over a separate plain HTTP request rather than back up the stream. Each SSE event carries its Redis Stream entry id as the event id, so a reconnecting EventSource resends it as Last-Event-ID and the server resumes from that entry.

## How the system is built
<!--meta block=architecture-->

The naïve version is fully synchronous: the **Chat Service** writes the user's message to Postgres, calls the **Inference Service** and blocks until the full completion returns, then writes the assistant message back. That satisfies the two functional requirements and nothing else — the client hangs for up to thirty seconds, and a GPU worker is called directly with no admission control. Two moves fix it, and both live in the deep dives. Streaming replaces the blocking call: a per-`runId` Redis Stream carries token deltas out of the worker, and any [stateless](../patterns/distributed/routing/stateless-service.md) Chat Service instance relays them to the browser over SSE. A [queue](../patterns/messaging/message-queue.md) replaces the direct call: the Chat Service enqueues a generation and returns immediately, and GPU workers pull work when they have room. The one deliberate split — cheap, stateless Chat Service versus GPU-bound, expensive Inference Service — lets each scale on its own axis.

~~~mermaid caption="The write path persists to Postgres; the generation path decouples through a queue and a per-`runId` Redis Stream, so any Chat Service instance can relay tokens over SSE."
flowchart LR
    Client["Web client"]
    GW["API Gateway"]
    Chat["Chat Service (stateless)"]
    DB[("Postgres — chats & messages")]
    Q["Generation queue"]
    Worker["GPU inference workers"]
    Stream[("Redis Stream — runId tokens")]

    Client -->|"POST /messages"| GW
    GW -->|"auth · rate limit"| Chat
    Chat -->|"persist message"| DB
    Chat -->|"enqueue prompt + runId"| Q
    Q -->|"workers pull when free"| Worker
    Worker -->|"append token deltas"| Stream
    Chat -->|"read stream by runId"| Stream
    Chat -->|"SSE stream to browser"| Client
~~~

## Deep dives
<!--meta block=deepdives-->

### 1 · Streaming tokens out fast, and keeping the stream unbroken

This is really two problems. Getting the first token onto the screen is pure latency; keeping the flow smooth thereafter — no gaps, correct order — is a reliability problem across a tier of instances that come and go. On transport, polling a status endpoint is rejected outright: a 300&nbsp;ms poll adds dead time and, at 120k concurrent streams, generates hundreds of thousands of mostly-empty requests per second. WebSockets work but overpay — a full-duplex, stateful connection for traffic that only ever flows one way. **Server-Sent Events** win: the browser opens an `EventSource` over ordinary HTTP, renders on the very first event, and auto-reconnects on drop, with no protocol upgrade for proxies to mishandle. Internally, the worker streams tokens to the Chat Service over gRPC server-streaming so it never has to buffer the whole completion.

Smoothness is the harder half. Pinning one client to the instance that started its generation would tie a client to a single box for thirty seconds — a routine deploy then either severs thousands of streams mid-sentence or blocks until they drain. Decoupling through Redis [pub/sub](../patterns/messaging/pubsub.md) keyed on the `runId` removes the pin: the worker publishes each token delta to the `runId` channel and whichever instance holds the client's SSE connection subscribes and forwards. Publishing deltas, not the growing full text, is essential — republishing the whole answer-so-far would be quadratic. But pub/sub is fire-and-forget: in the gap between an old instance dropping and a new one subscribing, tokens vanish, leaving a hole. The fix is a Redis **Stream** — an append-only log on the same `runId` key. Workers `XADD` each delta; an instance does a blocking `XREAD` from the client's last-seen entry id and, on reconnect to a different instance, replays exactly the missed entries before resuming live. The stream is bounded with `MAXLEN` and a short TTL (time to live), so it stays short-lived working state, never a second copy of history — the durable copy is the final assistant message written to Postgres.

### 2 · Scheduling generation across the GPU fleet

GPUs are the bottleneck, so how work reaches them decides both cost and tail latency. Direct synchronous dispatch — the naïve design — has no admission control and no view into which worker has room, so a spike slams already-saturated hardware and one long prompt can hog a worker while short ones wait behind it. The first improvement is a [queue between the Chat Service and a pool of pull-based workers](../patterns/distributed/resilience/load-leveling.md): the front end enqueues `(prompt, runId)` and returns fast, and workers pull when they have capacity. That buys room between a spiky producer (bursts to 20k prompts/sec) and a fixed-rate consumer (steady GPU throughput) — the queue turns a surge into extra wait rather than dropped requests, and the pull model is [competing consumers](../patterns/messaging/competing-consumers.md): workers share one queue, and they form a [worker pool](../patterns/concurrency/thread-pool.md).

Two things are still missing. The queue is unbounded, so sustained overload lets the line — and the wait — grow without limit; and treating each generation as one isolated job leaves the GPUs' best trick on the table. Both are addressed together. [Continuous batching](../patterns/concurrency/batching.md) advances many sequences by one token per forward pass (one run of the model over the batch), adding and dropping sequences on the fly so a finished generation is instantly replaced by a queued one — the single biggest lever on utilization, because a forward pass must stream the entire weight set out of high-bandwidth memory regardless of how many sequences ride along, so token generation is memory-bandwidth bound and batching amortizes that haul. (vLLM and TGI are the production serving layers built around this.) And [backpressure](../patterns/concurrency/backpressure.md) bounds the queue: past a depth threshold, admission control sheds or defers rather than letting latency climb, which also bounds wait time — an admitted request is only ever a bounded distance from the front, so a caller is either served within that bound or gets a fast "at capacity, try again" instead of an endless spinner. Set the threshold from the longest wait you will accept: depth is about that wait times the rate at which workers free slots.

### 3 · Fairness across users and priority across tiers

One scarce GPU pool is shared by everyone, and per-user cost is wildly uneven — a single 30k-token prompt burns more compute than a hundred one-liners. A flat, global [rate limit](../patterns/distributed/resilience/rate-limiter.md) (a [token bucket](../patterns/distributed/resilience/token-bucket.md) or fixed-window counter in Redis) fails on two counts: it measures requests, not tokens, so a giant prompt sails under a request cap while burning the most compute; and it's tier-blind, hitting paid and free users with the identical wall. Keying the limiter per `userId` stops one user draining the pool but still counts the wrong thing. The real answer meters actual scarcity: estimate a generation's cost from prompt length plus requested output, and check it against a per-user token budget that refills over time. Two distinct mechanisms serve two distinct goals — per-user cost budgets give fairness across users, while a tier-weighted queue gives priority across tiers, pulling paid requests ahead of free ones only when workers are contended. When even admission control isn't enough, a graceful-degradation policy leans on free traffic first: throttle, defer, or route it to a smaller, cheaper model before any paid user feels it — tempered by reserving a capacity floor for free traffic so strict priority can't starve it indefinitely.

### 4 · Controlling context cost without a forgetful assistant

The naïve "replay everything each turn" grows cost and latency turn over turn and eventually exceeds the context window. Truncation — keep the newest N turns, drop the rest — bounds the prompt with a simple `ORDER BY createdAt DESC LIMIT N`, but makes the assistant visibly forgetful, which hurts a product whose appeal is that it remembers. The better pairing keeps memory without paying full price. **Prefix caching** exploits that most of the prompt (system prompt plus everything already said) is identical turn to turn: the inference server caches the model's intermediate state — the key-value (KV) cache — for a stable prefix and only processes the new tail, cutting both cost and the time-to-first-token, and it pairs naturally with routing a conversation's turns back to a worker that already has its prefix warm. A **rolling summary** handles the hard context-window ceiling that caching can't: older history is compressed into a running summary while recent turns stay verbatim, so the prompt shape becomes system prompt → summary of old turns → last few turns → new message. The two complement each other, but the summary must update on a slower cadence, because rewriting it every turn would invalidate the prefix cache it depends on.

**Cancellation, and why a dropped tab isn't one.** When a user hits stop, the client calls the plain-HTTP `cancel` side-channel; the Chat Service flips the Generation to `cancelled` and publishes a signal on a control channel keyed by `runId`, and the worker — checking between token batches — drops the sequence and reclaims the GPU within one token batch rather than burning compute on an abandoned answer. A control-channel publish can be lost, so the worker also reads the Generation's status between batches and stops when it is cancelled. Crucially, closing the tab is not a cancel: the Redis-Stream-plus-reconnect design exists precisely so a dropped connection isn't read as termination. Generation continues in the background, and the user can reconnect or refetch the finished message from Postgres.

```mermaid caption="How does stop reclaim the GPU while a closed tab does not? Only the explicit cancel call flips the Generation and signals the worker, which checks between token batches."
sequenceDiagram
    participant B as Browser
    participant C as Chat Service
    participant R as Control channel (runId)
    participant W as GPU worker
    B->>C: cancel (plain HTTP)
    C->>C: flip Generation to cancelled
    C->>R: publish cancel signal
    R-->>W: cancel signal
    W->>W: check between token batches
    W->>W: drop the sequence, reclaim the GPU
    Note over B,W: a closed tab sends no cancel, so generation continues
```

```mermaid caption="How does a stream survive an instance dropping mid-sentence? The Redis Stream is the buffer: on reconnect to any other instance, XREAD replays exactly the missed deltas from the client's last-seen id."
sequenceDiagram
    autonumber
    participant B as Browser
    participant A1 as Chat instance 1
    participant A2 as Chat instance 2
    participant S as Redis Stream (runId)
    participant W as GPU worker
    W->>S: XADD each token delta
    A1->>S: XREAD from last-seen id
    S-->>A1: deltas
    A1-->>B: SSE token events
    alt instance 1 drops (deploy / crash)
        A1--xB: SSE connection lost
        B->>A2: reconnect, last-seen id
        A2->>S: XREAD from last-seen id
        S-->>A2: replay missed deltas
        A2-->>B: resume live
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- First token under ~500&nbsp;ms and smooth streaming, because SSE pushes each delta the instant a worker emits it.
- GPUs stay busy while the queue holds work — continuous batching refills freed slots; past the depth threshold, requests are shed with a fast "at capacity" reply instead of dropped silently.
- Fair sharing under contention — cost-aware budgets stop one heavy user starving the pool, and tier-weighted queueing protects paid users.
- In-flight streams survive deploys and reconnects — a per-`runId` Redis Stream replays the tokens an instance missed while they are within its MAXLEN and TTL; after that, the final message comes from Postgres.

### What it gives up
<!--meta polarity=con-->

- Availability is favoured over consistency, and per-token durability is given up outright — only the final assistant message is persisted.
- Cost budgets run on estimates — true output length is unknown until generation ends, so a user can overshoot a soft limit and reconcile afterward.
- Strict tier priority can starve free users through sustained peaks unless a capacity floor is deliberately reserved for them.
- Summarising old turns is lossy and adds an extra model call — recent context is protected, old history is not.
- Prefix caching ties a chat to one worker's memory — a turn routed to a different worker redoes the whole prefix, so cost and time to first token rise until routing returns to a warm worker.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working synchronous end-to-end flow (send a prompt, view past chats with context carried across turns), the recognition that a thirty-second blank screen won't fly and calls for push-based streaming like SSE, and at least the instinct to put a queue in front of the GPU workers.
- **Senior** — speeds through the high-level design to go deep on two-plus of streaming fanout, GPU scheduling, and fairness; argues SSE over WebSocket from the one-way nature of token flow; explains the queue-plus-continuous-batching trade-off for utilization; and proposes summarization or truncation for context cost.
- **Staff+** — drives three-plus deep dives with real depth, brings GPU economics in unprompted (120k concurrent streams imply tens of thousands of GPUs and a seven-figure daily bill, which is what justifies batching and backpressure), reaches prefix caching unaided, and cleanly separates fairness-across-users (per-user cost budgets) from priority-across-tiers (tier-weighted queueing).

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — a request queue sits between bursty prompts (~20k/s) and fixed-rate graphics processing unit (GPU) workers, absorbing spikes as bounded wait instead of dropped requests
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — a pool of graphics processing unit (GPU) workers pulls generation jobs off one shared queue whenever a worker has free capacity
- [Backpressure](../patterns/concurrency/backpressure.md) — the generation queue is bounded with an admission policy that sheds or defers once too deep, which also bounds an admitted request's wait time
- [Batching](../patterns/concurrency/batching.md) — continuous batching advances dozens of sequences per graphics processing unit (GPU) forward pass, the single biggest lever on utilization of memory-bandwidth-bound hardware
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — workers publish token deltas on a per-runId channel that whichever instance holds the client's server-sent events (SSE) connection subscribes to and relays
- [Correlation Identifier](../patterns/messaging/correlation-identifier.md) — a runId issued at generation start lets a worker and the connection-holding instance rendezvous without direct knowledge, and lets a reconnecting client resume the right stream
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — cost-aware per-user token budgets that refill over time, plus tier-weighted queueing, meter actual graphics processing unit (GPU) scarcity instead of raw request counts
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the Chat Service holds no per-request state, so any instance can serve, relay, or resume a stream and the tier redeploys and scales freely
- [Message Queue](../patterns/messaging/message-queue.md) — A durable queue sits between the Chat Service and the graphics processing unit (GPU) workers, so a prompt spike becomes wait time instead of dropped requests
- [Server-Sent Events](../patterns/messaging/server-sent-events.md) — one-way token flow, auto-reconnect and no protocol upgrade make SSE the transport for the answer

<!-- relationships:end -->
