---
title: WebSocket
description: "A two-way connection upgraded from HTTP (RFC 6455); either side sends at any time, at the cost of server-held connection state"
area: messaging
owner: Oleksandr Derechei
tags: [messaging, latency, state-management]
status: stable
aliases: [WS, WSS]
solves: [chat or live editing sends many small messages a second and one request per message is too slow, a user is connected to server A but the event happens on server B and never reaches them, the load balancer sends a returning client to a server that does not hold its open connection, a slow client falls behind on a live connection and the server memory grows until it crashes]
---

# WebSocket

WebSocket upgrades an HTTP connection into a persistent two-way channel (RFC 6455) where client and server send messages to each other at any time, with no request needed for each.

## What it is
<!--meta block=description-->

A WebSocket is an HTTP connection that both sides agree to upgrade into a long-lived two-way channel of small framed messages, text or binary. Either side can send at any moment. It suits chat, games and shared editing, where frequent messages each way make a request per message wasteful.

## Explained
<!--meta block=explain-->

A WebSocket is an HTTP connection that both sides agree to turn into a two-way message channel. The client sends a GET asking to upgrade, the server answers 101, and the same connection then carries small frames in both directions until one side closes it. Choose it over Server-Sent Events when the client also sends often, as in chat, games or shared editing, and over long polling when messages are frequent, because a frame costs a few bytes where a request costs full headers.

- **Server-bound state.** The socket lives on one server. Carry events to it over a shared publish-subscribe bus, or pin each client to its server.
- **No reconnect or replay.** Write backoff and resume-from-id yourself, and keep recent messages by id, since a plain bus cannot replay a gap.
- **No backpressure.** Cap each client's output buffer and disconnect slow readers.
- **Liveness and deploys.** Send pings so dead peers are found, and stagger restarts, since a deploy drops every socket on a server.

**Example.** A chat app runs on 4 servers with 100,000 users, so each server holds about 25,000 sockets. Ana is on server 1 and Raj on server 3. Raj sends a message, server 3 publishes it to the topic room-42, and server 1 is subscribed, so it writes the frame to Ana. Without the bus, the message would reach only users on server 3. Server 1 restarts for a deploy and drops 25,000 sockets, so clients reconnect after a random 1 to 10 s delay and ask for messages after their last id.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a message reach a user whose socket is on another server? The client upgrades at 1 and 2, its socket lives on server A, a sender on server B publishes at 3, the bus delivers to A at 4, and A writes down the open socket at 5."
flowchart LR
    C["Client"]
    subgraph A["Server A"]
        S[("Open socket")]
    end
    Bus["Message bus"]
    B["Server B"]
    C -->|"1 GET, Upgrade websocket"| S
    S -->|"2 101 Switching Protocols"| C
    B -->|"3 publish to user topic"| Bus
    Bus -->|"4 deliver to A"| S
    S -->|"5 frame to client"| C
```

1. The client sends an HTTP GET with the upgrade headers. Your auth check runs here, on the handshake.
2. The server answers 101 and the connection changes protocol. It stays open.
3. Another server, a job or a user's action publishes a message for this user to a topic.
4. The server holding the socket is subscribed to that topic and receives the message.
5. It writes a frame down the socket. The client can send frames back on the same connection at any time.

```mermaid caption="What keeps the connection honest, and what happens when it dies? Pings find a dead peer, and after a drop the client reconnects with backoff and asks for what it missed, because nothing replays automatically."
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Server
    C->>S: upgrade handshake
    S-->>C: 101 Switching Protocols
    C->>S: frame, message 1
    S-->>C: frame, message 2
    S->>C: ping
    C-->>S: pong
    Note over C,S: link dies, no pong arrives
    S->>S: close socket, free its state
    C->>S: reconnect after backoff, resume from last seen id
```

## Variations
<!--meta block=variations-->

- **Bus-backed stateless tier** — any server accepts any client, and a [publish-subscribe](./pubsub.md) bus carries each event to the server that holds the target socket. Scale-out is easy and a server holds only sockets, in the spirit of a [stateless service](../distributed/routing/stateless-service.md).
- **Sticky routing** — the balancer pins each client to one server, with a [sticky session](../distributed/routing/sticky-session.md) cookie or a hash of a user id. Per-user state stays in that server's memory, but a deploy or a crash disconnects everyone pinned to it.
- **Rooms and channels** — clients join named groups, and a message to the group is [fan-out](./fan-out.md) over the sockets that joined. Chat servers use this shape.
- **Subprotocol on top** — the handshake can name a subprotocol, such as STOMP or a JSON message format, so both ends agree on message types, acknowledgements and ordering.
- **Fallback transport** — a library tries a WebSocket and drops to [long polling](./long-polling.md) when a proxy blocks the upgrade.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Both directions, one connection** — client and server each send whenever they like, so chat, games and shared editing need no second channel.
- **Low overhead per message** — after the handshake a frame adds a few bytes of header, not a full set of HTTP headers.
- **Low latency** — a message is on the wire at once, with no request round trip or polling gap.
- **Text and binary frames** — you can send compact binary data directly, which a text-only stream cannot.

### Cons
<!--meta polarity=con-->

- **Stateful servers** — each socket lives on one server, so you need a bus or sticky routing to reach it, and a deploy drops its connections.
- **No built-in reconnect or replay** — after a drop you write reconnect, backoff and resume-from-id yourself, or a client misses messages.
- **No automatic backpressure** — a fast sender can fill a slow reader's buffer, so you bound queues and drop or disconnect slow clients.
- **Costs at the edge** — each socket is a held connection that load balancers, proxies and idle timeouts must allow, and a connection flood is a denial-of-service route.
- **Handshake auth and Origin** — a browser sends no custom headers on the upgrade, so authenticate by cookie or a first message and check the Origin header, or any site can open a socket with the user's cookies; a token can also expire while the socket stays open, so re-check it on a timer.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Both sides send often** — chat, multiplayer games or collaborative editing send many small messages a second in each direction.
- **Latency is the product** — trading screens and live cursors need a message delivered in milliseconds, not after a request cycle.
- **You send binary data** — audio, game state or compact protocol frames fit binary frames and not a text-only stream.

### Avoid when
<!--meta polarity=avoid-->

- **The server only pushes** — a feed or dashboard gets automatic reconnect and a resume id from [Server-Sent Events](./server-sent-events.md), so you keep a window of recent events but run no two-way protocol.
- **Updates are rare** — a held socket per client for one event an hour is waste, so use [long polling](./long-polling.md) or plain polling.
- **You cannot keep connections open** — serverless functions and some proxies end long connections, so use [long polling](./long-polling.md) or a managed gateway that holds them.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a Node server with rooms, heartbeat and slow-client cut-off, using the ws library"
import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({ port: 8080 });
const rooms = new Map<string, Set<WebSocket>>();
const alive = new WeakSet<WebSocket>();

wss.on("connection", (ws, req) => {
  const room = new URL(req.url!, "http://x").searchParams.get("room") ?? "lobby";
  (rooms.get(room) ?? rooms.set(room, new Set()).get(room)!).add(ws);
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));              // peer answered the ping
  ws.on("message", (data, isBinary) => {           // fan out to the room
    for (const peer of rooms.get(room)!) {
      if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
      if (peer.bufferedAmount > 1_000_000) peer.terminate(); // slow reader
      else peer.send(data, { binary: isBinary });
    }
  });
  ws.on("close", () => rooms.get(room)!.delete(ws));
});

setInterval(() => {                                // heartbeat every 30 s
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 30_000);
```

## In the wild
<!--meta block=wild-->

- **RFC 6455** — The IETF standard of 2011 that defines the handshake, framing, ping and pong, and close codes; browsers implement it through the WebSocket API. {#wild-rfc6455}
- **Discord Gateway** — Clients keep a WebSocket to the gateway to receive events in real time, with a heartbeat the client must send. {#wild-discord}
- **Phoenix Channels** — The Elixir web framework runs channels over WebSockets, with topics that connect clients across nodes. {#wild-phoenix}
- **Amazon API Gateway WebSocket APIs** — A managed service that holds the WebSocket connections and calls your backend for each message. {#wild-apigw}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **ping interval and timeout** — How often the server pings and how long it waits for the pong before it closes the socket. Keep the interval well below the shortest proxy idle timeout on the path; the sketch pings every 30 s.
- **max message size** — A cap on one frame or message, so one client cannot make the server allocate large buffers.
- **send buffer limit** — The queued output allowed per connection before you drop messages or disconnect the client. The sketch cuts at 1,000,000 bytes; size it from your largest message times how many you allow queued.
- **reconnect backoff with jitter** — The client delay after a drop, randomised so a restart does not trigger a synchronised wave.
- **replay window** — How many messages or seconds of history per room the server keeps for resume-from-id; a client that asks for an older id gets a full resync.

### Signals to watch
<!--meta polarity=signal-->

- **open connections per node** — The main capacity number; each socket takes memory and a file descriptor, so set the alert from the limit you measure on one node under load.
- **connects and disconnects per second** — A rise after a deploy or a network fault shows churn and the reconnect wave.
- **output buffer size per connection** — Growing buffers show slow clients before they exhaust a node's memory.
- **message delivery latency** — Time from publish to frame written; it should stay in milliseconds, and bus lag shows here first.

### Failure modes under load
<!--meta polarity=failure-->

- **reconnect storm** — A deploy or balancer reset drops many sockets, and all clients return at once, overloading the auth and handshake path.
- **slow reader** — A client that cannot keep up makes queued output grow until the node runs out of memory.
- **idle timeout cuts the socket** — A proxy or balancer closes a quiet connection. Without pings, clients look connected until their next send fails.
- **lost messages across a reconnect** — Nothing replays by itself, so messages sent while the client was away are gone unless the app resumes from an id.

### Readiness checklist
<!--meta polarity=check-->

- Authenticate during the handshake and check the origin
- Ping and pong detect dead peers before the idle timeout fires
- Output buffers and message sizes have limits
- Clients reconnect with jittered backoff and resume from the last id
- Balancer and proxy timeouts allow long-lived connections
- Deploys drain connections gradually instead of dropping them together

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Real-Time Updates](../../themes/realtime-updates.md) — Two-way connection that the infrastructure must hold open {#fluency-realtime-updates}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Publish-Subscribe](./pubsub.md) — A bus carries each event to the server that holds the target socket.
- [Sticky Session](../distributed/routing/sticky-session.md) — Pinning a client to one server keeps its socket and per-user state together.
- [Fan-Out](./fan-out.md) — A message to a room is fan-out over the sockets that joined it.
- [Stateless Service](../distributed/routing/stateless-service.md) — A thin connection tier holds the sockets while the rest stays stateless.
- [Retry with Backoff](../distributed/resilience/retry-backoff.md) — The client reconnects after a jittered, growing delay.
- [Backpressure](../concurrency/backpressure.md) — A send-buffer cap is how you push back on a slow reader.

**Alternative to**

- [Long Polling](./long-polling.md) — Falls back to long polling when the upgrade is blocked.
- [Server-Sent Events](./server-sent-events.md) — Pick WebSocket when the client also sends often.

**Exposed to**

- [Head-of-Line Blocking](../../hazards/head-of-line-blocking.md) — Can fall into head of line blocking when one multiplexed ordered connection lets one slow message delay all the others behind it
- [Thundering Herd](../../hazards/thundering-herd.md) — Can fall into thundering herd when a deploy drops many sockets and every client reconnects at the same instant.

**Implemented by**

- [Networking](../../capabilities/networking.md) — Managed connection services hold the open sockets, so your backend handles messages rather than connections.

<!-- relationships:end -->
