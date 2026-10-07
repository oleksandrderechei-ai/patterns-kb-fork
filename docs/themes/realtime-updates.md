---
title: Real-Time Updates
description: "Pushing fresh data to clients the moment it changes, without them asking"
area: themes-data
owner: Oleksandr Derechei
tags: [event-driven, latency, state-management]
status: stable
aliases: [push notifications, live updates, server push]
---

# Real-Time Updates

Standard HTTP is request/response: the client asks, the server answers, the connection closes. Real-time updates is the theme for the opposite direction — the server needs to push a change to a browser or app the instant it happens, and no one wants to poll for it. That splits into two questions you solve separately: which protocol carries bytes to the client, and how an event reaches the one server that holds that client's connection.

## The question
<!--meta block=description-->

Two people edit one document, and each expects the other's keystroke within milliseconds. HTTP only lets the client ask, so the server cannot reach a client that is not asking, and a million clients polling hard would flatten the infrastructure. This theme splits the problem into two hops: the protocol that delivers a change to the client, and the path that carries an event across the fleet to the server holding that connection.

## Explained
<!--meta block=explain-->

Real-time updates push a change to a client the moment it happens, instead of the client asking again and again. Plain web requests only let the client ask, so you choose how to push, then how an event born on one server reaches the server holding that client connection. Polling on a timer is enough when a few seconds of delay is fine. [Server-sent events](../patterns/messaging/server-sent-events.md), a one-way stream, fit feeds and dashboards, and a [WebSocket](../patterns/messaging/websocket.md), a two-way connection, fits chat and shared editing. Any push method makes the connection stateful, because one server holds the socket in memory. To reach that server, have each server subscribe to a broker through [publish-subscribe](../patterns/messaging/pubsub.md), or assign each user to one server by [hashing](../patterns/distributed/routing/consistent-hashing.md). The broker is the better default when per-connection state is cheap to rebuild.

- **One more system.** A clustered broker survives losing a node, but events in flight can drop. Clients catch up from a store by last-seen id.
- **Reconnect storms.** A server with 50,000 sockets cannot be redeployed quietly. Drain it gradually, have clients retry after a random delay, keep it thin.
- **Held connections.** Sockets use memory and file handles. Load-test one server for its cap, keep headroom for reconnects, and size the fleet from it.

**Example.** A chat app has 1,000,000 users on 20 servers, 50,000 sockets each. If every client polled the database every 10 s, that is 100,000 reads a second for mostly empty answers. With WebSockets and a broker, a message to a room is published once, and only the servers with members of that room forward it. A user can connect to any server, so a plain least-connections load balancer is enough. The cost is the broker, and a client that reconnects must catch up on missed messages from the store.

## The tradespace
<!--meta block=tradespace-->

Once the client protocol is chosen, the design tension moves to the second hop, and it comes from a single fact: any protocol that pushes (long-polling, SSE, WebSocket) makes the connection stateful. One specific server now holds this client's socket in local memory. When an event is born on some other server, the system has to answer "which server owns this connection, and how does the event get there?" There are three answers, and they trade delivery speed against operating cost against how much state you pin.

**Poll the store.** Writers persist updates to a database; the connection-holding servers query it for "anything newer than X." It keeps all state in the store and needs no special infrastructure, but it brings back the latency and load you pushed to avoid. If each of a million clients polls a shared table every ten seconds, that is a hundred thousand reads a second, mostly for updates that have not changed. If only the connection-holding servers poll, reads scale with the server count, but delay stays at the poll interval. Reach for it only when near-real-time is good enough.

**Hash the connection to an owning server.** A coordination service assigns each user to a specific server, and senders look up that server and forward the event directly. Plain `hash(user) % N` works until you change `N`: a scale event then reshuffles nearly every connection into a reconnect storm, so **consistent hashing** is what makes ownership survive growth, moving only the connections in the affected ring segment. This is the right answer when the per-connection state is expensive to rebuild: a live editing session that has loaded a document, replayed pending operations, and synced collaborators does not want to migrate on every deploy. The cost is that scaling becomes an explicit, choreographed migration. If the owning server dies, its clients reconnect, the coordination service reassigns its ring segment, and events sent to it meanwhile are lost, so clients reconnect with jittered backoff and deploys drain gradually.

**Broadcast over pub/sub.** A broker sits in the middle; connection-holding servers stay thin and stateless, each subscribing to the topics for the clients it happens to hold, and a publish fans out to every subscribed server, which forwards to its own clients. Now a client can connect to any server, because the broker, not a hash ring, does the routing. Load balancing is a plain "least connections" and no ownership map is needed. This is the best general-purpose balance for most designs; the price is a broker that becomes a bottleneck and single point of failure to plan around, plus a little indirection latency. Plain pub/sub is fire-and-forget: a client that reconnects, or a server mid-redeploy, misses events published meanwhile, so pair the broker with a store and resume from the last-seen event id.

Two forces stretch all of this. **Scaling stateful connections** is the first. A stateless request handler can be added or killed freely. A server holding many thousands of open sockets cannot be redeployed without either severing and reconnecting every client or handing live connections off. The common move is therefore to terminate connections in a dedicated, thin connection tier and keep the rest of the system stateless behind it. The second is **celebrity fan-out**: when one write must reach millions of simultaneous subscribers, per-subscriber push melts down. The answer shifts to hierarchical aggregation and broadcast fan-out rather than a flat loop over followers. The [Facebook Live Comments](../designs/fb-live-comments.md) case study works the celebrity fan-out through, [Online Chess](../designs/online-chess.md) pins each game to one owning server, and [Robinhood](../designs/robinhood.md) streams live prices.

```mermaid caption="The client protocol is only the first hop. The design work is routing an event to the one server that owns a given connection — poll, pin, or broadcast."
flowchart TB
    D{"Which server holds this client's connection?"}
    D -->|"Near-real-time is fine"| P["Poll a shared store"]
    D -->|"Per-connection state is expensive to rebuild"| H["Pin ownership via consistent hashing"]
    D -->|"State is cheap; keep servers thin"| B["Broadcast over pub/sub"]
    H -->|"scaling becomes a migration"| S["Explicit, choreographed scale events"]
    B -->|"broker routes, servers stay thin"| L["Any server works: least-connections balancing"]
```

## Patterns behind both hops
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Long Polling](../patterns/messaging/long-polling.md) {#tour-long-polling}

The entry that needs no new infrastructure. The client holds a request open until news or a timeout, then asks again, so most proxies and clients work, if the hold time stays under their idle timeout. Choose it for occasional updates, or as the fallback when a better transport is blocked, and accept a request per message.

### [Server-Sent Events](../patterns/messaging/server-sent-events.md) {#tour-server-sent-events}

One long-lived HTTP response the server writes events down. The browser reconnects by itself and sends the last event id back, so a server that keeps recent events can resume the stream; feeds, dashboards and streamed artificial intelligence (AI) answers need little extra protocol work. The limit is one direction and text only.

### [WebSocket](../patterns/messaging/websocket.md) {#tour-websocket}

When both sides send often, upgrade the connection to full duplex. The socket lives on one server, so every event for the user needs a bus or an owner lookup (a hash ring) to reach it. Reconnect with replay from a last-seen event id, backoff on reconnect, and a send-queue cap that drops or disconnects slow clients are yours to build.

### [Publish-Subscribe](../patterns/messaging/pubsub.md) {#tour-pubsub}

The general-purpose answer to the server-side hop. A writer publishes an event to a topic without knowing who holds the affected connections; the broker routes it to every server subscribed on behalf of a listening client. It is what lets the connection tier stay thin and any-server-works, because ownership lives in topic subscriptions rather than in a hash ring.

### [Consistent Hashing](../patterns/distributed/routing/consistent-hashing.md) {#tour-consistent-hashing}

When a connection carries expensive state you don't want to rebuild, you pin each user to an owning server and route events there directly. Consistent hashing is what makes that assignment survive scaling: adding or removing a server moves only the connections in one ring segment instead of triggering a fleet-wide reconnect storm.

### [Sticky Session](../patterns/distributed/routing/sticky-session.md) {#tour-sticky-session}

A push connection is a stateful connection: once a client's socket lands on a server, the [load balancer](../patterns/distributed/routing/load-balancer.md) can't freely move it without breaking the link. Session affinity keeps a reconnecting or long-polling client on the instance that already holds its state; an open socket stays on its server anyway. With a broker it is not needed, and it does not carry events to the socket's server, which is what the hash-owner lookup does.

### [Fan-out](../patterns/messaging/fan-out.md) {#tour-fan-out}

One event frequently has to reach many connections: every viewer of a live comment thread, every follower of a post. Fan-out copies one published event to every subscriber, and it has to become hierarchical, in tiers, when one writer's audience runs into the millions.

### [Stateless Service](../patterns/distributed/routing/stateless-service.md) {#tour-stateless-service}

Stateful sockets are the hard part to scale, so confine them. Terminate connections in a dedicated tier and push identity, history and application logic into shared stores. The rest of the system stays stateless and deployable; only the thin connection layer holds long-lived state.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

Pick the client protocol by direction and frequency, then pick the server-side hop by how much per-connection state you're pinning and how many subscribers one event must reach. Start at the simplest row that meets the requirement and escalate only when it stops holding. Escalate when polling reads on the store, delivery delay against the requirement, or sockets per server pass the limit a load test gives you.

| When the update is… | Client protocol | Server-side hop |
| --- | --- | --- |
| Not latency-sensitive, or a short "live" window | Simple polling | Poll a shared store |
| Occasional and one-off (e.g. a payment result) | [Long-polling](../patterns/messaging/long-polling.md) | Poll a shared store |
| One-way server→client stream (feeds, dashboards, AI tokens) | [Server-Sent Events](../patterns/messaging/server-sent-events.md) | [Publish-Subscribe](../patterns/messaging/pubsub.md) broadcast |
| Bidirectional and high-frequency (chat, collaborative editing) | [WebSocket](../patterns/messaging/websocket.md) | [Publish-Subscribe](../patterns/messaging/pubsub.md), or [consistent hashing](../patterns/distributed/routing/consistent-hashing.md) when the connection state is costly to rebuild; add [sticky session](../patterns/distributed/routing/sticky-session.md) to keep a reconnecting or long-polling client on one server |
| One source watched by millions (celebrity, live event) | SSE or WebSocket | [Hierarchical fan-out](../patterns/messaging/fan-out.md) over the broadcast layer |
| Peer-to-peer, lowest latency, or native audio/video | WebRTC (not covered in the KB) | Signaling server only (a server that only helps peers find each other; itself a real-time channel) |
| Holding millions of long-lived sockets at scale | Any push protocol | Terminate in a thin [stateless](../patterns/distributed/routing/stateless-service.md) connection tier |

## Related areas
<!--meta block=siblings-->

- [Streaming](./streaming.md) — The mirror image, and easy to confuse. Streaming is server-side data-stream processing — producer/consumer pipelines chewing through unbounded events. This theme is client-facing delivery: getting one of those processed events out to a browser or app. They often meet at the same pub/sub broker, approaching it from opposite sides.
- [Scalability](./scalability.md) — Delivering to a few clients is easy; the whole difficulty is holding millions of stateful connections at once. Statelessness, consistent hashing, and fan-out are shared machinery for making the connection fleet grow.
- [Handling Spikes](./spike-handling.md) — Live features spike hardest — a viral moment or a live event floods the connection tier and the fan-out layer at the same instant, which is exactly the load the [celebrity problem](../hazards/hot-key.md) describes.
- [Long-Running Tasks](./long-running-tasks.md) — Hand the caller a handle to collect later, instead of holding a request open for the result. This theme pushes the result to the client; that one lets the client fetch it.
