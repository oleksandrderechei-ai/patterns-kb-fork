---
title: Server-Sent Events
description: One long-lived HTTP response the server writes events down; the browser reads it with EventSource and reconnects by itself
area: messaging
owner: Oleksandr Derechei
tags: [messaging, latency, asynchrony]
status: stable
aliases: [SSE, EventSource, text/event-stream]
solves: ["the server only sends updates to the page, but we run a two-way socket and write reconnect code for it", my live feed drops on a bad connection and the client misses events while it was offline, an AI answer must appear token by token but a normal HTTP response arrives only when complete, a dashboard asks for fresh numbers every few seconds and most answers are the same as the last]
---

# Server-Sent Events

Server-Sent Events keep one HTTP response open and let the server write a stream of events down it, and the browser's `EventSource` reads them and reconnects by itself when the link drops.

## What it is
<!--meta block=description-->

Server-Sent Events keep one HTTP response open and write events down it as lines of text, each ending with a blank line and optionally carrying an id. The browser reads them through EventSource and reconnects by itself. It suits one-way feeds such as dashboards, notifications and streamed answers, where WebSocket would add more than the feed needs.

## Explained
<!--meta block=explain-->

Server-Sent Events are one HTTP response that never ends. The client opens it with a GET, and the server writes events down it as lines of text, each ending with a blank line and usually carrying an id, which replay needs. The browser reads them through the EventSource API. Choose it over a WebSocket when data only flows from server to client, such as a feed, a dashboard or a streamed answer: it is plain HTTP, so your proxies and cookies work unchanged, though a buffering proxy delays events and auth is cookies only. Its big gain is automatic reconnect. After a drop the browser waits, reconnects and sends the last id it saw in a Last-Event-ID header, and the server replays what was missed if it kept a window of recent events.

- **One direction.** The client cannot send upstream, so any message to the server is a separate request.
- **Text only.** Events are text, so encode binary data.
- **Connection limit.** Browsers allow about 6 HTTP/1.1 connections per host, so use HTTP/2.
- **Buffering proxies.** They delay events. Turn buffering off on that route and send a comment line every 15 to 30 seconds.

**Example.** A build page shows live logs to 5,000 viewers. Each log line is one event with an id, about 120 bytes. A viewer on a train loses signal at line 8,412 and gets it back 20 s later. The browser reconnects with Last-Event-ID 8412, and the server replays the 35 lines it kept in a 1,000-line window, so the viewer sees no gap. Had the server kept only 20 lines, the viewer would silently lose the oldest 15 of the 35 missed lines, so the window must cover your longest expected outage. The cost is 5,000 open connections held on the server.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one HTTP response carry many events? The browser opens it at 1, the server keeps it open at 2, events from a bus are written down it at 3 and 4, and after a drop the browser reconnects at 5 with the last id so the server replays from there."
flowchart LR
    B["Browser EventSource"]
    subgraph S["Server"]
        H["Open response"]
    end
    Bus[("Event bus")]
    B -->|"1 GET, Accept text/event-stream"| H
    H -->|"2 200, response stays open"| B
    Bus -->|"3 event 7"| H
    H -->|"4 write id 7, data"| B
    B -->|"5 reconnect, Last-Event-ID 7"| H
```

1. The browser creates `new EventSource(url)`, which sends a GET and keeps the connection.
2. The server sends headers and then holds the response open, sending a comment line every 15 to 30 seconds so proxies do not close an idle stream.
3. An event reaches the server, from a write or a [publish-subscribe](./pubsub.md) topic.
4. The server writes the event with an `id` and flushes. The browser fires a `message` event, or one named by `event:`.
5. After a drop the browser waits `retry` milliseconds, reconnects and sends `Last-Event-ID`. The server replays everything after it.

```mermaid caption="What does the wire look like, and how does a drop heal? Events carry ids, the link breaks after id 8, and the browser's reconnect carries 8 so the server resends 9 onward."
sequenceDiagram
    autonumber
    participant B as Browser
    participant S as Server
    B->>S: GET /stream
    S-->>B: id 7, data order shipped
    S-->>B: id 8, data order delivered
    Note over B,S: connection drops
    B->>S: GET /stream, Last-Event-ID 8
    S-->>B: id 9, data refund issued (replayed)
```

## Variations
<!--meta block=variations-->

- **Replay from `Last-Event-ID`** — the server keeps a window of recent events by id and resends the missed ones on reconnect. Without a window a reconnect silently skips events.
- **Streamed response body** — the server sends the same event format as a response to a `fetch` call and the client reads it with a stream reader. This allows POST bodies and custom headers, which `EventSource` cannot send, but you write the reconnect yourself. It is how many AI APIs stream answers.
- **Per-user stream** — one stream per signed-in user, fed from a per-user topic on a [publish-subscribe](./pubsub.md) bus, so any server can hold the stream and the bus carries the event to it. The replay window must live on the bus or in a store keyed by user and id, not in one server's memory, because a reconnect can land on a different server.
- **Named event types** — the `event:` field lets one stream carry several kinds, and the client adds a listener per name.
- **Fan-out through a hub** — a separate hub process holds the open connections and the application publishes to it by HTTP. The Mercure protocol follows this design.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reconnect is built in** — `EventSource` retries and sends the last id, so you write no reconnect loop. A drop costs a delay, not a missed feed, if the server keeps a replay window; past the window events are lost.
- **Plain HTTP** — it passes through ordinary proxies, uses normal cookies and auth, and compresses with the usual response encodings.
- **Cheap per event** — after the first request an event costs only its own bytes, not a request round trip.
- **Simple server** — it is a response that never ends, and any stack that can flush a response can serve it.

### Cons
<!--meta polarity=con-->

- **One direction only** — the client cannot send down the stream, so upstream messages need a second HTTP call and you correlate the two.
- **Text only** — events are UTF-8, so binary data needs base64 and costs about a third more bytes.
- **Connection limits on HTTP/1.1** — browsers allow about 6 connections per host, shared across tabs, so several open streams starve the page. HTTP/2 lifts this by multiplexing.
- **Buffering proxies break it** — a proxy that holds the response until it ends delays every event, so you disable buffering on that route.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The server talks and the client listens** — a live feed, a dashboard, a build log or a streamed AI answer, where upstream traffic is an occasional ordinary request.
- **You want automatic reconnect** — a flaky mobile link drops often, and the browser retries and sends the last id, so you write no reconnect loop and only keep the replay window.
- **You stay on plain HTTP** — your auth, logging and load balancing already speak it, and a new protocol would need new infrastructure.

### Avoid when
<!--meta polarity=avoid-->

- **The client sends as often as it receives** — chat, games and shared editing need both directions on one connection, so use [WebSocket](./websocket.md).
- **Events are rare and a held stream is wasteful** — one result a minute after a long wait fits a held request, so use [long polling](./long-polling.md).
- **You need binary frames or custom request headers** — native `EventSource` cannot set headers, and browser WebSocket cannot either, so use [WebSocket](./websocket.md) for binary frames and a streamed `fetch` for headers or a POST body.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a Node stream endpoint with replay and keepalive, and the browser side"
import { createServer, type ServerResponse } from "node:http";

// ids restart at 1 on restart and history is per process: keep both in the bus or a store to survive restart or more than one node
const history: { id: number; data: string }[] = []; // recent events
const clients = new Set<ServerResponse>();
const WINDOW = 1000;           // events kept for replay: peak events/s × longest outage
const MAX_BACKLOG = 1 << 20;  // bytes buffered before a slow client is cut (tune)

function send(res: ServerResponse, e: { id: number; data: string }) {
  res.write(`id: ${e.id}\ndata: ${e.data}\n\n`);   // blank line ends the event
}
export function publish(data: string) {
  const e = { id: (history.at(-1)?.id ?? 0) + 1, data };
  history.push(e);
  if (history.length > WINDOW) history.shift();
  clients.forEach((c) => (c.writableLength > MAX_BACKLOG ? c.destroy() : send(c, e)));
}

createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const last = Number(req.headers["last-event-id"] ?? 0);
  history.filter((e) => e.id > last).forEach((e) => send(res, e)); // replay
  clients.add(res);
  const ping = setInterval(() => res.write(": keepalive\n\n"), 20_000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
}).listen(8080);

// Browser: reconnect and Last-Event-ID are automatic.
// const es = new EventSource("/stream");
// es.onmessage = (m) => console.log(m.lastEventId, m.data);
```

## In the wild
<!--meta block=wild-->

- **EventSource in the HTML Standard** — Browsers implement the EventSource interface and the text/event-stream format as written in the WHATWG HTML Standard, including the Last-Event-ID reconnect. {#wild-whatwg}
- **Mercure** — A protocol and hub, created by Kevin Dunglas, that pushes updates to browsers over Server-Sent Events. {#wild-mercure}
- **Anthropic Messages API streaming** — Setting stream to true returns the answer as server-sent events as it is generated. {#wild-anthropic}
- **OpenAI API streaming** — Setting stream to true returns response chunks as server-sent events. {#wild-openai}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **retry field** — The reconnect delay in milliseconds the server tells the browser to use; the browser default applies if you omit it. A fixed value only delays the wave, so send a randomised value per connection to spread it.
- **keepalive interval** — How often the server sends a comment line. Measure the shortest idle timeout on the path and keep the interval below it; 15 to 30 s is a starting point, and the sketch's 20 s assumes every timeout is longer.
- **replay window** — How many recent events the server keeps for Last-Event-ID; the sketch counts events. Size it as peak events per second times the longest disconnect you accept, and read that disconnect from replay size per reconnect.
- **max streams per node** — A cap on open connections, sized to file descriptors and memory.

### Signals to watch
<!--meta polarity=signal-->

- **open streams per node** — Tracks held sockets; growth toward the cap is the early warning.
- **reconnects per second** — A spike after a deploy or a network event shows the wave the server must absorb.
- **replay size per reconnect** — Large replays mean clients are offline longer than expected or the window is small.
- **write backlog per connection** — A slow client makes buffered output grow, and memory grows with it.

### Failure modes under load
<!--meta polarity=failure-->

- **proxy buffering** — A proxy holds the response until it ends, so events arrive in late bursts or not at all.
- **reconnect storm** — A restart makes every client reconnect at once, and each triggers a replay, so load spikes twice.
- **connection limit reached** — On HTTP/1.1 about 6 connections per host are shared across tabs, so extra streams block page loads.
- **silent gap** — Events carry no ids or the window is too short, so a reconnect skips events without any error.

### Readiness checklist
<!--meta polarity=check-->

- Every event carries an id and the server honours Last-Event-ID
- A keepalive comment goes out more often than any idle timeout
- Proxy buffering is disabled on the stream route, for nginx with the X-Accel-Buffering: no response header
- The stream is served over HTTP/2 or the per-host limit is planned for
- Slow clients are disconnected once their buffered output passes a limit

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Real-Time Updates](../../themes/realtime-updates.md) — One-way stream over plain HTTP with built-in reconnect {#fluency-realtime-updates}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Publish-Subscribe](./pubsub.md) — A per-user topic on the bus feeds the stream held by whichever server has the connection.
- [Reverse Proxy](../distributed/routing/reverse-proxy.md) — Turn buffering off on the stream route and keep its idle timeout above the keepalive interval.

**Alternative to**

- [Long Polling](./long-polling.md) — Long polling is the fallback when a proxy or client cannot hold a stream.
- [WebSocket](./websocket.md) — Pick server-sent events (SSE) when data only flows server to client and you want reconnect for free.

**Demonstrated by**

- [Facebook Live Comments](../../designs/fb-live-comments.md) — a live comment feed pushes events to millions of viewers and replays the gap from the last event id
- [ChatGPT](../../designs/chatgpt.md) — streams a model answer to the browser, with a Redis Stream replaying missed tokens on reconnect

<!-- relationships:end -->
