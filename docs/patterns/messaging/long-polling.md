---
title: Long Polling
description: "Hold each HTTP request open until the server has news or a timeout, then ask again: near-push updates over plain HTTP"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, latency, asynchrony]
status: stable
aliases: [Comet, hanging GET]
solves: ["clients check for updates every second and almost every answer is empty, but slower checks make updates arrive late", my page must show a result the moment it is ready but only plain HTTP gets through the proxy, I need live updates and cannot run WebSockets or streaming behind our firewall or load balancer, waiting on one slow job result means the client keeps asking and the server keeps answering no]
---

# Long Polling

Long polling is a request the server deliberately leaves unanswered until it has news or a timeout fires, so a client gets updates over plain HTTP without hammering the server with empty checks.

## What it is
<!--meta block=description-->

Plain polling asks every second or two and most replies are empty. Long polling parks each HTTP request until an event arrives or a timeout fires, set below the path's shortest idle limit (often 20 to 60 seconds). The client asks again at once with a cursor, the last event id. It gives the latency of a push and the load of a slow poll, with no new infrastructure, and unlike [Server-Sent Events](./server-sent-events.md) or [WebSocket](./websocket.md) each connection carries one answer.

## Explained
<!--meta block=explain-->

Long polling is a request the server leaves unanswered on purpose. The client asks for events after the last id it saw, and the server parks the request until an event arrives or a timeout of 20 to 60 seconds fires, then answers. The client asks again at once. Choose it over plain polling when updates are occasional and late is not acceptable: an idle client costs one request per timeout instead of one per second, and an event leaves the moment it exists. Choose it over a streaming connection when proxies, firewalls or old clients only handle ordinary request and response.

- **Held sockets.** Each parked request holds a socket, so use an event-driven server or cap parked requests per node.
- **Request per event.** Each event costs a full request, so batch events that arrive close together.
- **Gaps.** An event between two requests can be missed, so send a cursor and keep a short window of recent events.
- **Reconnect storms.** After a restart every client returns together, so add jitter (a random delay) to the retry.

**Example.** A shop shows 200,000 buyers the status of a card payment. Polling every 2 s sends 100,000 requests a second, and nearly all answer no. With long polling and a 30 s hold, each buyer sends about 1 request per 30 s, around 6,700 a second, and sees the result in well under a second. The cost is 200,000 parked sockets, which an event-driven server holds in memory but a thread-per-request server cannot. A restart makes all 200,000 reconnect; a random 1 to 5 s delay still means about 50,000 requests a second at the start, so widen the window.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a server push an event over plain request and response? The client asks at 1, the server parks the request at 2, an event reaches the server at 3, and the parked request is answered at 4 so the client asks again at 5 with its cursor."
flowchart LR
    C["Client"]
    subgraph Srv["Server"]
        W[("Parked requests")]
    end
    E["Event source"]
    C -->|"1 GET /events?after=41"| W
    W -->|"2 hold, nothing new"| W
    E -->|"3 event 42 published"| W
    W -->|"4 200 with event 42"| C
    C -->|"5 GET /events?after=42"| W
```

1. The client sends a request with the cursor of the last event it processed.
2. The server registers the request as waiting, then checks for newer events. If there are any it answers at once; if not it sends nothing, so an event published in between still wakes it.
3. An event is published, from a write, a job or a [publish-subscribe](./pubsub.md) topic the server listens to.
4. The server finds the parked requests the event concerns and answers each with it.
5. The client handles the event and sends the next request at once, with the new cursor.

```mermaid caption="What happens when nothing arrives, and when the answer is in flight? An idle request ends with an empty reply at the timeout, and an event that lands between two requests is not lost as long as the server still holds events back to the cursor the next request asks from."
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Server
    C->>S: GET after=41
    Note over S: no events, hold up to 30s
    S-->>C: 204 timeout, no news
    C->>S: GET after=41
    Note over C,S: event 42 is published while the client is between requests
    S-->>C: 200 events 42 (found at once, nothing to wait for)
    C->>S: GET after=42
    Note over S: hold again
```

The timeout is not a failure. It keeps the request under the idle limit of every proxy and load balancer on the path, and it lets the server drop the clients that have gone away.

## Variations
<!--meta block=variations-->

- **Cursor resume** — the client sends the id of the last event it handled, and the server returns everything after it. This is what closes the gap between two requests, and it needs the server to keep a short window of recent events.
- **Batching hold** — the server waits a few milliseconds after the first event before answering, so a burst of events leaves as one response instead of one request round trip each.
- **Per-channel waits** — one request waits on a topic or user inbox. The server keeps a map from channel to waiting requests, so an event wakes only the requests that care.
- **Transport fallback** — a library starts on long polling and upgrades to [WebSocket](./websocket.md) once the connection allows it, and stays on long polling when a proxy blocks the upgrade. Socket.IO works this way.
- **Queue long poll** — a consumer waits on an empty queue for up to a set time, so it does not spin on empty reads. Amazon SQS (Simple Queue Service) exposes this as a receive-wait time.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Works through everything** — it is plain HTTP, so proxies, firewalls and every client library handle it, and nothing new is deployed.
- **Near-push latency** — an event leaves the moment it exists, with no polling interval to wait out.
- **Stateless-friendly** — the cursor travels with each request, so no [sticky session](../distributed/routing/sticky-session.md) is needed, provided the event window sits in a store or topic every node reads.
- **Cheap when idle** — a quiet client costs one request per timeout, not one per second.

### Cons
<!--meta polarity=con-->

- **A request per message** — headers and connection setup repeat for every event, which hurts at high rates.
- **Held connections cost memory** — each parked request holds a socket and often a thread, so a blocking server runs out of workers first.
- **Gaps can lose events** — between a response and the next request nothing is listening, so you need a cursor and a retained window.
- **Reconnect storms** — when a server restarts, every client re-asks at once, so you add jitter to the retry delay.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Updates are occasional** — you wait on a payment result or a job status that changes a few times, and a held connection per client is not worth building.
- **Your network blocks upgrades** — an old proxy or corporate firewall breaks streaming and WebSocket, and plain HTTP is the only path that works.
- **You need a fallback** — a better transport is your first choice, and you want a path that always works behind it.

### Avoid when
<!--meta polarity=avoid-->

- **The server pushes often** — dozens of events a second turn into dozens of request round trips, so use [Server-Sent Events](./server-sent-events.md).
- **The client also sends often** — chat or shared editing pays for every upstream message too, so use [WebSocket](./websocket.md).
- **A slow answer needs no live wait** — a status resource the client checks later is simpler, so use [asynchronous request-reply](../distributed/routing/async-request-reply.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a handler that parks until news or timeout, and a client loop with a cursor"
type Ev = { id: number; data: string };
const log: Ev[] = [];                       // recent events, oldest first
const waiters = new Set<() => void>();      // parked requests
const WINDOW = 1000;    // event window; tune to the resume gap

export function publish(data: string) {
  log.push({ id: (log.at(-1)?.id ?? 0) + 1, data });
  if (log.length > WINDOW) log.shift();   // trim: keep a window, not every event
  waiters.forEach((wake) => wake());        // wake every parked request
}

export async function handle(after: number, holdMs = 25_000) {
  const fresh = () => log.filter((e) => e.id > after);
  if (fresh().length) return { status: 200, events: fresh() };
  await new Promise<void>((resolve) => {
    const t = setTimeout(done, holdMs);     // answer empty at the timeout
    function done() { clearTimeout(t); waiters.delete(done); resolve(); }
    waiters.add(done);
  });
  const events = fresh();
  return events.length ? { status: 200, events } : { status: 204, events };
}

// Client: ask, handle, ask again at once, back off with jitter on error.
async function poll(url: string, after = 0) {
  let delay = 1000;
  for (;;) {
    try {
      const r = await fetch(`${url}?after=${after}`);
      if (!r.ok) throw new Error(String(r.status));
      if (r.status === 200) for (const e of await r.json()) after = e.id;
      delay = 1000;                          // success resets the backoff
    } catch {
      await new Promise((r) => setTimeout(r, delay * (0.5 + Math.random())));
      delay = Math.min(delay * 2, 30_000);   // double up to a cap, with jitter
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **Amazon SQS long polling** — A ReceiveMessage call can set WaitTimeSeconds up to 20, so the call waits for a message instead of returning empty at once. {#wild-sqs}
- **Socket.IO** — Its HTTP long-polling transport is the fallback when a WebSocket connection cannot be made, and it upgrades once one works. {#wild-socketio}
- **Telegram Bot API getUpdates** — A bot passes a timeout and an offset, so the call waits for new updates and resumes from the last one it handled. {#wild-telegram}
- **CometD with the Bayeux protocol** — A long-polling transport for pushing events to browsers, one of the Comet implementations. {#wild-cometd}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **hold timeout** — How long a request waits. Keep it below the idle timeout of every proxy and load balancer on the path, or they cut it first.
- **retry delay and jitter** — How long a client waits after an error or a restart. Random jitter spreads the reconnect wave.
- **event window** — How many recent events or how many seconds the server keeps so a cursor can resume across the gap.
- **max parked requests per node** — A cap that returns an early reply or rejects, so waiting clients cannot exhaust sockets or workers.

### Signals to watch
<!--meta polarity=signal-->

- **parked requests per node** — Tracks held sockets and workers; a climb toward the cap predicts exhaustion.
- **share of empty timeout replies** — A high share means the hold is too short or the event rate too low to justify the pattern.
- **event-to-reply latency** — Time from publish to the reply leaving; it should stay in milliseconds.
- **reconnect rate after a deploy** — A spike shows the wave your retry jitter has to flatten.

### Failure modes under load
<!--meta polarity=failure-->

- **reconnect storm** — A restart or a load balancer reset makes every client reconnect at once, and the wave overloads the survivors.
- **idle timeout shorter than the hold** — A proxy cuts requests early, so clients loop with failed replies.
- **events lost in the gap** — No cursor or window covers the time between two requests, so an event published there is never delivered.
- **workers exhausted** — A thread-per-request server runs out of workers because each parked request holds one.

### Readiness checklist
<!--meta polarity=check-->

- Hold timeout is shorter than every idle timeout on the path
- Every request carries a cursor and the server keeps a window to resume from it
- Clients retry with jitter and capped backoff
- A cap on parked requests per node is set and tested
- You load-tested the full reconnect wave from one node restart

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Real-Time Updates](../../themes/realtime-updates.md) — Hold a request open until there is news {#fluency-realtime-updates}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Publish-Subscribe](./pubsub.md) — A publish-subscribe topic is how an event reaches the server holding the parked request.

**Alternative to**

- [Server-Sent Events](./server-sent-events.md) — Both push news over HTTP; long polling answers once per request, server-sent events (SSE) streams many events down one response.
- [WebSocket](./websocket.md) — Use it when only plain request and response gets through, at a request per message.

**Variant of**

- [Asynchronous Request-Reply](../distributed/routing/async-request-reply.md) — The same ask-and-wait shape, repeated for a stream of events instead of one result.

**Often confused with**

- [Polling Consumer](./polling-consumer.md) — A polling consumer asks a queue at its own pace and may get nothing; long polling parks one HTTP request until data arrives or a timeout fires.

<!-- relationships:end -->
