---
title: WhatsApp
description: "Deliver a message in under 500 ms to whoever is online, store it for whoever is not, across hundreds of millions of persistent connections"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [messaging, availability, durability, latency]
status: stable
aliases: [chat app, messenger, messaging app design]
solves: [a message I send to someone who is offline just disappears instead of arriving when they finally reconnect, chat only works while both people sit on the same server and breaks when I add a second machine, polling a REST endpoint for new messages wastes bandwidth and still feels laggy, "a phone drops signal and the socket still looks open, so messages vanish with no error", the same conversation shows its messages in a different order on my laptop than on my phone]
---

# WhatsApp

A messaging service carries a message from one phone to another — fast when the recipient is online, and eventually when they are not. The hard part is not the chat mechanics; it is doing both at the same time, for billions of devices that each hold one long-lived connection, without ever losing a message.

## Understanding the problem
<!--meta block=description-->

A chat service delivers a message in real time to whoever is online and durably to whoever is not. The page treats a 1:1 chat as a group chat of two, builds the simplest system that meets the requirements, then uses deep dives to survive real load: billions of messages a day, and a million-plus live connections per host.

## Explained
<!--meta block=explain-->

A chat service holds one long-lived connection per device, writes each message to storage before it tries to deliver it, and then pushes it live through a [publish-subscribe](../patterns/messaging/pubsub.md) channel keyed by recipient, so the sender never needs to know which server holds the recipient. The server keeps the message until the device acknowledges it, so an offline recipient gets it on reconnect. Choose this when latency is the product and the write rate is ordinary: about 100,000 writes a second, split by user, is routine for a managed key-value store. The real bill is the connection fleet, 200 million live sockets over many hosts. Without the stored copy, a message pushed to a phone that just lost signal is gone.

- **Lossy live push.** The push is at-most-once. Number messages per chat and send the latest number with the heartbeat to expose gaps.
- **Loose ordering.** Strict order is refused. Stamp server receipt time; clock skew between hosts can put one message above a later one.
- **Device multiplier.** Each device adds an inbox write per message. Cap devices per account; compute online status from socket state.

**Example.** 200 million users send 20 messages a day: 4 billion a day, about 40,000 a second, and about 100,000 writes a second counting inbox rows. Alice sends to Bob, who has 2 devices, so 1 message row and 2 inbox rows are written first. His phone gets the push and acks; his laptop is off, so its row waits. If the phone's ack is lost the server resends, and the phone drops the repeat by message id. If it sees numbers 41 then 43 on the heartbeat, it asks for 42.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Start a group chat with up to 100 participants (a 1:1 chat is the two-person case).
2. Send and receive messages within a chat.
3. Receive messages sent while offline, retained for up to 30 days.
4. Send and receive media — images, video, files — inside messages.

Out of scope, named to keep the design narrow: voice and video calling, business accounts, and registration or profile management.

### Non-functional
<!--meta requirement=nfr-->

- **Latency** — delivery under 500&nbsp;ms to online recipients.
- **Deliverability** — messages must eventually reach every recipient; none may be silently lost.
- **Scale** — about 1B users, 200M connected at once, high throughput.
- **Frugal storage** — messages live on central servers no longer than necessary.
- **Resilience** — the system tolerates the failure of any single component.

Out of scope: an exhaustive treatment of end-to-end encryption, and spam or scraping defence.

## Right-sizing
<!--meta block=sizing-->

**Writes.** Assume ~20 messages per active user per day across 200M active users — roughly 4B messages/day, about **40k messages/sec**. Each message becomes one write to the `Message` table plus one `Inbox` write per recipient. Because 1:1 chats dominate, [fan-out](../patterns/messaging/fan-out.md) is small on average; even accounting for groups the total lands near **100k writes/sec** (100k ÷ 40k is 2.5 inbox writes per message; one message to a 100-member group on up to 3 clients each is about 300). Partitioned by `userId`, that is comfortably inside a managed key-value store like DynamoDB.

**Connections.** Of ~1B users, budget for **~200M connected at once**. A single well-tuned socket host historically carried 1–2M live connections, so the fleet is **100 to 200 chat servers at minimum, hundreds with headroom**. Sender and recipient will usually be on different hosts.

**Storage.** Messages are small and short-lived (30-day retention), so the durable footprint is bounded by retention, not by history. Media is the heavy part, and it is deliberately pushed out of this budget onto object storage.

## Core entities
<!--meta block=entities-->

A handful of records, most of them thin:

- **User** — an account; the unit everything is addressed to.
- **Client** — a single device belonging to a user. One user may have several (phone, laptop, tablet), so delivery targets a client, not just a user.
- **Chat** — a conversation of 2–100 participants; primary key is the chat id.
- **ChatParticipant** — the membership join. Partition key `chatId`, sort key `participantId` lists a chat's members; a global secondary index keyed the other way lists a user's chats.
- **Message** — the payload plus a server-stamped receipt time and a chat sequence number. The sequence number comes from an atomic per-chat counter incremented on write, so one writer orders each chat; a very busy chat makes that counter a hot key.
- **Inbox** — a per-client holding queue of message ids not yet acknowledged by that device.

## The interface
<!--meta block=interface-->

Representational state transfer (REST) is the wrong tool. Chat is high-frequency and bidirectional — the server must push to the client as often as the client pushes to the server — and a request/response protocol has no way to do that. Instead each client opens one persistent **WebSocket over Transport Layer Security (TLS)** and both sides send framed commands over it. The connection is the primitive; the request/response verbs below travel inside it. `createAttachment { body, hash } -> { attachmentId }` is an HTTPS upload to the attachment service, not a socket command; the socket carries only the attachmentId.

```javascript summary="Socket commands — client ↔ server"
// client -> server
createChat            { participants:[], name }        -> { chatId }
sendMessage           { chatId, message, attachments } -> { status, messageId }
modifyChatParticipants{ chatId, userId, op }           -> "SUCCESS" | "FAILURE"
ack                   { messageId }                    -> (none)
sync                  { chatId, afterSeq }             -> { messages }

// server -> client  (pushed)
chatUpdate  { chatId, participants }              -> "RECEIVED"
newMessage  { chatId, userId, message, attachments } -> "RECEIVED"
```

The detail that makes durability work is the `ack`. Every server-to-client push demands a matching acknowledgement from the client. Until that ack arrives, the server assumes the message has not landed and keeps it. That single rule — deliver, wait for ack, only then forget — is what turns "we sent it" into "they got it." The cost of it is duplicates: a push whose ack is lost in transit is resent, so a client can be handed the same message twice. That is fine because applying a message is [idempotent](../patterns/messaging/idempotency.md) — a client writes it into the chat keyed by message id, and a second copy of an id it already holds is dropped rather than shown twice. The client generates the messageId in sendMessage and the server drops a repeat of an id it already stored, so a retry after a lost response writes the message once. After a reconnect or a gap on the heartbeat, the client calls sync with the last sequence number it holds.

## How the system is built
<!--meta block=architecture-->

An [L4 load balancer](../patterns/distributed/routing/load-balancer.md) spreads incoming socket connections across a fleet of **chat servers** — layer 4 is enough because a WebSocket is one long-lived connection, not a stream of routable HTTP requests. Each chat server keeps an in-memory map of `clientId → socket` for the clients it holds. When a message arrives it does two things: it writes the message to the `Message` table and drops a row into each recipient's [Inbox](../patterns/distributed/coordination/inbox.md) so the message is durable before anything else happens; then it delivers to whoever is online.

The catch is that the recipient's socket almost certainly lives on a different chat server. Rather than have every server track where every client is, each server subscribes on a [pub/sub](../patterns/messaging/pubsub.md) channel keyed by the ids of its own connected users (Redis channels). To deliver, the sending server just publishes to the recipient's channel; whichever server holds that recipient is subscribed and pushes the `newMessage` down the socket. Media never travels this path — a client uploads attachments to a separate **attachment service** backed by [object storage](../patterns/distributed/routing/object-storage.md) and the message carries only an `attachmentId`, keeping large binaries off the hot delivery path (a [claim check](../patterns/messaging/claim-check.md)).

```mermaid caption="Durability first (write to store), then real-time delivery via a per-user pub/sub channel that hides which server holds the recipient. Media detours through the attachment service."
flowchart LR
    Sender["Sender client"]
    LB["L4 load balancer"]
    CS1["Chat server A"]
    Store[("DynamoDB — Chat, Message, Inbox")]
    PS(("Redis pub/sub — per-user channels"))
    CS2["Chat server B"]
    Recipient["Recipient client"]
    Attach[("Attachment service — object storage")]
    Sender -->|"sendMessage over WebSocket"| LB
    LB -->|"route socket"| CS1
    CS1 -->|"persist message and per-recipient inbox"| Store
    CS1 -->|"publish to recipient's channel"| PS
    PS -->|"recipient subscribed here"| CS2
    CS2 -->|"newMessage push, awaits ack"| Recipient
    Sender -.->|"upload media, get attachmentId (claim check)"| Attach
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Routing across hundreds of chat servers

With ~200M live connections spread over hundreds of hosts, sender and recipient rarely share a server, so delivery becomes a routing problem. A per-user Kafka topic is a non-starter — brokers top out around 10–20k topics, not millions. [Consistent hashing](../patterns/distributed/routing/consistent-hashing.md) can map each user deterministically to a server, but you then own the hard parts yourself: hot nodes, and redistributing connections every time a host is added or removed. Offloading to pub/sub sidesteps all of it — servers subscribe to their users' channels and the broker handles membership. The partitioning choice is by **user**, not by chat: because 1:1 chats dominate, per-chat channels would create a mountain of near-duplicate channels for little gain, and chats are capped at 100 members anyway. The one exception is the [celebrity problem](../hazards/hot-key.md) — a rare very-large chat. Above a size threshold (say 25 members) clients also subscribe to a per-chat channel and senders publish there instead, publishing to both briefly during the transition so no server misses the switch.

Messages route by recipient channel, with a per-chat channel only for large chats:

```mermaid caption="How does a message reach the right chat server without each server knowing where every user is connected?"
flowchart LR
    Sender["Sender's chat server"]
    subgraph PS["Redis pub/sub"]
        UserCh[("Recipient's user channel")]
        ChatCh[("Per-chat channel (chats above ~25 members)")]
    end
    Dest["Recipient's chat server"]
    Members["Large-chat members' clients"]
    Sender -->|"publish to recipient's channel"| UserCh
    UserCh -->|"deliver to subscribed server"| Dest
    Sender -->|"large chat: publish here instead"| ChatCh
    ChatCh -->|"deliver to subscribed clients"| Members
```

### 2 · One user, many devices

A user reads on a phone and a laptop, and both must stay in sync — so a single per-user inbox is not enough. A `Clients` table keyed by user id resolves each participant to its active devices; the `Inbox` becomes per client; and a message fans out to every one of a recipient's clients, each acking independently. The pub/sub layer is untouched — channels are still keyed by `userId`. To bound the storage and throughput this multiplies, the number of clients per account is capped (around 3).

### 3 · Detecting a dead socket

A WebSocket can look open while being functionally dead — a phone that walked into an elevator. TCP keepalives can take minutes to notice, far too slow for chat, and you would otherwise only discover the break when a send times out. The fix is **application-level heartbeats**: the client emits a small liveness ping on an interval, and a missed heartbeat marks the connection dead promptly, independent of the TCP layer.

### 4 · When pub/sub drops a message

Redis pub/sub is at-most-once — if no subscriber is listening at the instant of publish, the message is simply gone. Durability for offline recipients is already covered, because the message was written to the `Inbox` before it was ever published. The remaining gap is a connected client that missed a live push. Three mechanisms layer up: per-chat **sequence numbers** let a client notice a hole and request the missing range; those sequence numbers ride along on the heartbeat, so liveness and gap-detection share one signal; and periodic polling is the final backstop. Production systems run all three at once.

### 5 · Ordering without a global clock

Guaranteeing strict send-order delivery would mean buffering and reordering late arrivals — the kind of watermark machinery stream processors like Flink use, and far more complexity than users actually want. Instead, chat servers sync their clocks with NTP (Network Time Protocol) and stamp each message with its server-receipt time; every client sorts by that stamp. All devices then agree on an order, at the cost of the occasional message that "pops in" above one that was really sent later — a trade users happily accept for speed.

### 6 · "Last seen" without hammering the database

Writing to the database on every heartbeat would be a torrent of writes for a low-value signal. Presence is already knowable for free: a user is online exactly when they hold an active socket and channel subscription. Work out "last seen" from that connection state rather than persisting it, and the feature costs almost nothing.

```mermaid caption="A connected client missed a live push — how does it notice and recover the message? The Inbox write makes it durable; per-chat sequence numbers on the heartbeat expose the hole."
sequenceDiagram
    autonumber
    participant Origin as Sender's chat server
    participant PS as Redis pub/sub
    participant Dest as Recipient's chat server
    participant Store as Inbox / Message store
    participant Client as Recipient client
    Origin->>Store: write message, seq N (durable)
    Origin->>PS: publish to recipient channel
    alt subscriber listening at publish
        PS-->>Dest: deliver
        Dest->>Client: push newMessage, seq N
    else no subscriber (at-most-once drop)
        PS--xDest: message dropped
        Client->>Dest: heartbeat carries last seq N-1
        Dest-->>Client: gap detected, seq N missing
        Client->>Store: fetch missing range
        Store-->>Client: message N
    end
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Sub-500&nbsp;ms delivery to online users over persistent sockets, with pub/sub hiding which server holds the recipient.
- No message is lost while it sits in the inbox: write-to-inbox-before-publish plus the deliver-then-ack loop redelivers until acked or the 30-day retention ends.
- Scales to about 200M live sockets by sharding connections across hundreds of hosts; adding servers only changes channel subscriptions, not application logic.
- Media stays off the chat and database path, so large binaries never slow message delivery.

### What it gives up
<!--meta polarity=con-->

- Ordering is approximate — server-receipt timestamps, not true send order, so a message can surface above a later one.
- Correctness leans on layered detection (heartbeats, sequence gaps, polling) rather than one clean guarantee, because pub/sub is at-most-once.
- Presence and liveness rest on connection state that is fuzzy on flaky networks; a dead socket looks alive until a heartbeat is missed.
- Per-client inboxes multiply storage and throughput by device count, forcing a cap on clients per account.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a clear socket-based API and a working end-to-end design that meets the functional requirements, with the honest observation that a single chat server won't scale and some awareness of where a first scaling attempt is rough.
- **Senior** — moves briskly through the happy path to spend real time on scaling and robustness: argues consistent-hashing versus pub/sub, weighs partition-by-user against partition-by-chat, and can explain the mechanics of a long-lived socket.
- **Staff+** — goes two or three levels deep on failure modes — dead-socket detection, recovering from at-most-once pub/sub, multi-device sync, the celebrity chat — and volunteers regionalization and cell-based architecture as the operational realities behind billions of users.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Clock Skew](../hazards/clock-skew.md) — Order is by server-receipt time, so skew between chat servers lets a message sit above a later one.

**Demonstrates**

- [Publish-Subscribe](../patterns/messaging/pubsub.md) — chat servers subscribe to per-user channels so a sender reaches a recipient without knowing which host holds their socket
- [Inbox](../patterns/distributed/coordination/inbox.md) — every undelivered message is written to a per-client inbox before delivery, so an offline recipient still receives it on reconnect
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — an L4 load balancer spreads long-lived WebSocket connections across the chat-server fleet
- [Claim Check](../patterns/messaging/claim-check.md) — a message carries only an attachmentId, keeping large media off the real-time delivery path
- [Object Storage](../patterns/distributed/routing/object-storage.md) — media is uploaded to a dedicated attachment service backed by object storage rather than the message database
- [Fan-Out](../patterns/messaging/fan-out.md) — one sent message is delivered to every chat participant and to each of their multiple devices
- [Idempotency](../patterns/messaging/idempotency.md) — clients ack each push and the server resends until acked, tolerating duplicates so nothing is ever lost
- [Actor Model](../patterns/concurrency/actor-model.md) — Erlang's actor model packs a million-plus live connections per host, each user a lightweight process with its own mailbox

<!-- relationships:end -->
