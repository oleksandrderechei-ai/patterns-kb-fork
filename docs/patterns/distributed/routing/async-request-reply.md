---
title: Asynchronous Request-Reply
description: "Accept the work, hand back a handle, and let the caller collect the result later"
area: distributed-routing
owner: Oleksandr Derechei
tags: [api-design, asynchrony, latency]
status: stable
aliases: ["202 Accepted", long-running operation, LRO, polling status endpoint]
solves: [the load balancer kills the connection before the report finishes rendering, users click submit twice because nothing happened for ninety seconds and the work runs twice, the request thread sits blocked for four minutes doing nothing but waiting, the client has no way to find out whether the import finished or died, a burst of uploads takes the whole web tier down with it]
---

# Asynchronous Request-Reply

Splits accepting a request from doing the work it asks for. The caller gets an immediate acknowledgement and the address of a status resource; the work runs elsewhere at its own pace, and the caller collects the result by polling that address or by being called back. The reply still arrives — it just no longer has to fit inside one connection.

## What it is
<!--meta block=description-->

**Asynchronous request-reply** answers a slow request in two parts. The first response says only that the request was accepted and where to look for the outcome. The outcome arrives later, when the work is done, so the answer no longer depends on a connection staying open for the length of the work.

## Explained
<!--meta block=explain-->

Asynchronous request-reply splits a slow request in two: you reply at once with 202 Accepted and the address of a status resource, and the caller collects the result there later. The submit records the job durably before it answers, and the status resource reports running, succeeded or failed, with Retry-After to pace the caller. Without it, a 2-minute job holds a connection until a timeout kills the caller's request while the work carries on unseen. Choose how the caller learns the result by who is calling. Polling works behind a firewall and costs a request per caller per interval. A callback costs one message but is yours to deliver, and a held-open channel gives the lowest delay for one connection per waiter. Keep a failed submit (a normal error) apart from a failed job (a state on the status resource), so callers can tell never taken from did not work.

- **Poll load.** A thousand callers asking every 5 s is 200 requests a second, so return Retry-After, add jitter and back off.
- **Duplicate work.** A caller who missed your 202 resubmits, so make the submit safe to repeat with a caller-supplied key.
- **Lost jobs.** A dead worker leaves a job running forever, so give unfinished jobs a deadline and keep results for slow callers.
- **Callbacks.** An unreachable caller never hears back, so retry with backoff, park failures aside and sign the message.

**Example.** A client submits an export that takes 2 minutes and gets back 202 Accepted with the address /exports/88/status. It polls every 5 s, so one job costs 24 polls. Its network drops after the submit, so it resends with the same key, k-1, and you answer with job 88 instead of starting a second export. The worker dies at 90 s, and the 5-minute deadline then marks job 88 failed. The cost of polling is the 24 requests per job: with 1,000 callers at once that is 200 requests a second.

## How it works
<!--meta block=structure-->

```mermaid caption="What has to be true before the 202 is sent? The job record and the queue entry both — an acknowledgement that outlives a crash the work does not survive is a promise you cannot keep."
flowchart LR
    C["Client"]:::ext
    subgraph Accept["Accept — durable before the 202"]
        API["Submit endpoint"]
        J[("Job store")]
        Q[("Work queue")]
    end
    W["Worker"]
    S["Status endpoint"]
    C -->|"1 POST /reports, Idempotency-Key"| API
    API -->|"2 record the job as accepted"| J
    API -->|"3 enqueue the work"| Q
    API -->|"4 202 Accepted, Location: /operations/id"| C
    Q -->|"5 claim"| W
    W -->|"6 write the terminal state and result"| J
    C -->|"7 GET /operations/id"| S
    S -->|"8 read the current state"| J
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Why does the submit need an idempotency key? The caller cannot tell a lost response from a rejected request, so it retries — and without the key that retry is a second report being rendered and billed."
sequenceDiagram
    participant C as Client
    participant A as API
    participant W as Worker
    C->>A: POST /reports (Idempotency-Key: k1)
    A-->>C: 202 Accepted, Location /operations/9, Retry-After 5
    C->>A: POST /reports (Idempotency-Key: k1) retry, the 202 was lost
    A-->>C: 202 Accepted, the SAME operation, no second job
    C->>A: GET /operations/9
    A-->>C: 200 running, Retry-After 10
    W->>A: mark operation 9 succeeded, resource /reports/2025
    C->>A: GET /operations/9
    A-->>C: 303 See Other, Location /reports/2025
    C->>A: GET /reports/2025
    A-->>C: 200 the report
```

## Variations
<!--meta block=variations-->

- **Polled status resource** — The caller asks the status endpoint how things are going, on an interval the server suggests. It needs nothing of the caller except the ability to make requests, which is why it is the default for public APIs and the only option when callers sit behind a firewall. The cost is a stream of requests that carry no information most of the time, and it grows with the number of waiting callers rather than with the work.
- **Callback on completion** — The caller registers a URL when it submits, and you post the outcome there once. Polling load disappears and the caller learns the moment the work finishes. In exchange you have taken on a delivery obligation: the endpoint will be down sometimes, so you need retries with backoff, a dead-letter for what never lands, and a signature the receiver can verify — plus a way for the caller to reconcile after an outage, which usually means keeping the polled status resource anyway.
- **Held-open push channel** — The caller opens a server-sent event stream or a websocket and is told the instant the state changes. Notification latency is as low as it goes, which suits an interactive screen watching one job. It costs a live connection per waiting caller, and it recovers badly on its own — a client that reloads has to fall back to a poll to find out what it missed.
- **Result behind a [claim check](../../messaging/claim-check.md)** — The terminal status carries a short-lived link to the payload rather than the payload itself, and the caller fetches it from [object storage](./object-storage.md). It keeps the status resource small and cheap to poll no matter how large the output gets, and it lets the download be resumed and range-requested. The link's lifetime is now part of the contract, and it has to outlast a caller that polls slowly.
- **Fire-and-forget** — There is no reply at all: the submit is acknowledged and the caller never asks again. It is the cheapest shape and the right one for telemetry and notifications, where nobody acts on the outcome. It is the wrong one everywhere else, because the caller has no way to distinguish work that completed from work that was silently dropped.
- **Reply on a second queue** — Where the transport is a broker rather than HTTP, the caller sends to a request queue and waits on a response queue, tagging the message with an identifier the responder echoes back so the reply reaches the caller that is waiting — a [Correlation Identifier](../../messaging/correlation-identifier.md). A per-caller reply queue named in the message itself works the same way and disappears with the caller. The caller blocks on an answer, so this rebuilds a synchronous call on asynchronous plumbing and takes on the broker's failure modes.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The response no longer** has to fit inside a connection timeout, so work that takes minutes stops depending on a network nobody controls.
- **The request tier stays cheap** and stateless while the expensive work runs on hardware suited to it, scaled on its own.
- **A durable job record** turns a lost connection into a recoverable state, because the caller can ask again what happened for as long as terminal state retention lasts.
- **A burst of submissions** becomes queue depth rather than a pile of held connections, so load is absorbed rather than refused, until depth outgrows what workers can drain within the operation deadline.

### Cons
<!--meta polarity=con-->

- **Every caller now writes a loop**, a termination condition and a timeout where it used to write one call.
- **You are running a job** store and a queue, and both of them can now be the reason a request fails.
- **Polling load scales** with waiting callers rather than with work, and clients that ignore `Retry-After` set the rate themselves.
- **Without an idempotency key on the submit**, an ambiguous timeout becomes duplicated work the caller never asked for.
- **An operation that never reaches** a terminal state is invisible: nothing errors, and the caller polls a running job whose worker died an hour ago.
- **Terminal state retention is a real deadline.** Expire it before a slow caller collects and the result is gone: the status read returns 404, the same as for an id that never existed.
- **A caller that gives up** cannot stop a running job, so abandoned work and its cost continue unless the operation resource offers a cancel that workers check.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The work routinely takes longer** than the timeouts of the proxies and load balancers between you and the caller.
- **The caller needs the outcome eventually**, but not before it can do anything else.
- **The expensive work belongs** on different hardware or a different scaling curve than the request tier.
- **Submissions arrive** in bursts you would rather absorb than refuse.

### Avoid when
<!--meta polarity=avoid-->

- **The work finishes in tens of milliseconds**, where a status resource is more machinery than the operation.
- **The caller cannot proceed without the answer anyway**, so polling only relocates the wait and adds a round trip to it.
- **Nobody ever reads the outcome**, where fire-and-forget is honest and a status resource is theatre.
- **The process has many meaningful** intermediate steps with compensation between them, which a durable workflow models better than a single operation record.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an idempotent submit and a status resource that redirects on completion"
// SUBMIT: everything durable BEFORE the 202. Acknowledging work you have not
// yet recorded is a promise that a crash one millisecond later cannot keep.
app.post("/reports", async (req, res) => {
  const key = req.header("Idempotency-Key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key required" });
  // Insert-or-return: a retried submit gets the ORIGINAL operation, not a second job.
  const op = await db.one(
    `INSERT INTO operations (id, idempotency_key, state, params)
          VALUES (gen_random_uuid(), $1, 'accepted', $2)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, state, (xmax = 0) AS inserted`, [key, req.body]);
  if (op.inserted) await queue.enqueue({ operationId: op.id }); // NOT atomic with the INSERT as written: write an outbox row in the same transaction, or a crash here loses an accepted job
  res.status(202).location(`/operations/${op.id}`).set("Retry-After", "5").json({ id: op.id, state: op.state });
});
// STATUS: one resource, three answers. 303 hands the caller to the result so it
// never has to learn a second URL, and Retry-After keeps the poll rate yours.
app.get("/operations/:id", async (req, res) => {
  const op = await db.oneOrNone(`SELECT * FROM operations WHERE id = $1`, [req.params.id]);
  if (!op) return res.sendStatus(404);          // retention expired, or never existed
  if (op.state === "succeeded") return op.resource_url ? res.redirect(303, op.resource_url)
                                                       : res.json({ state: "succeeded", result: op.result });
  if (op.state === "failed") return res.json({ state: "failed", error: op.error }); // 200: the ASK succeeded
  // Back the interval off as the operation ages, so a thousand waiting
  // callers do not turn into a poll storm against the job store.
  const age = Date.now() - Date.parse(op.created_at);
  res.set("Retry-After", String(Math.min(60, 5 + Math.floor(age / 10_000)))).json({ state: op.state });
});
```

## In the wild
<!--meta block=wild-->

- **Google Cloud long-running operations** — A slow method returns an `Operation` resource instead of a result. It carries `done`, and then either `response` or `error`; callers poll `operations.get`, and the same shape is reused across services so one client knows how to wait for all of them. {#wild-google-lro}
- **Azure Resource Manager async operations** — Slow control-plane calls answer `202 Accepted` with an `Azure-AsyncOperation` or `Location` header naming the status resource, plus `Retry-After` to set the polling interval. {#wild-azure-async}
- **Amazon Textract** — Document analysis is split in two: a start call returns a `JobId`, a get call polls it, and completion can also be published to a notification topic so callers can stop polling entirely. {#wild-aws-textract}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Polling interval and backoff** — The `Retry-After` you return and how it grows as an operation ages. Set it, or a thousand waiting clients will choose an interval for you.
- **Idempotency key lifetime** — How long a submitted key is remembered and returns the original operation. Shorter than the longest client retry window turns a retry into duplicate work.
- **Terminal state retention** — How long a finished operation stays readable. Expire it before a slow caller polls and the result is lost with no error raised anywhere.
- **Operation deadline** — The age at which a non-terminal operation is force-failed. Without one, a worker that dies mid-job leaves a job that is running forever.
- **Callback retry policy** — Attempts, backoff and the dead-letter destination for results that cannot be delivered. A callback you try once is a result you sometimes drop.
- **Queue visibility timeout** — How long a claimed job is hidden from other workers. Shorter than the work takes and the job is processed twice; much longer and a crashed worker parks it until the timeout expires.

### Signals to watch
<!--meta polarity=signal-->

- **Age of the oldest non-terminal operation** — It rises the moment workers stop draining, typically long before any error rate moves.
- **Accepted versus terminal rate** — Submissions in against completions out. A sustained gap is a backlog forming, whatever the queue depth says.
- **Poll requests per operation** — How many status reads each operation costs. It shows whether clients honour `Retry-After` and whether polling is becoming the dominant load.
- **Duplicate submission rate** — Submits that matched an existing idempotency key. A rise means clients are timing out before the 202 reaches them.
- **Callback delivery failure rate** — Notifications that exhausted their retries. Each one is a caller that will never learn the outcome unless it falls back to polling.

### Failure modes under load
<!--meta polarity=failure-->

- **Poll storm** — Many clients on a fixed short interval turn waiting into the dominant traffic, and the status reads starve the job store the workers need. Jitter and an ageing backoff are the fix.
- **Duplicated work from a lost acknowledgement** — The 202 never reaches the client, the client retries, and without an idempotency key the expensive work runs twice and is billed twice.
- **Operations stuck running forever** — A worker dies after claiming a job and before writing a terminal state. Nothing errors; callers poll a job nobody is doing.
- **Acknowledged but never enqueued** — The 202 is sent before the job record and the queue entry are both durable, so a crash in that window loses work the caller was told you accepted.
- **Result expired before collection** — Terminal state retention runs out while a slow or offline caller is still coming back for it, and the outcome is gone with no failure recorded.

### Readiness checklist
<!--meta polarity=check-->

- The job record and the queue entry are both durable before the 202 is sent
- The submit is idempotent on a caller-supplied key
- Status responses carry `Retry-After`, and the interval grows with operation age
- Every non-terminal operation has a deadline that force-fails it
- Terminal state retention outlasts the slowest client that is meant to collect
- A rejected submit and a failed operation are distinguishable in the API
- Large results are handed back as a link rather than inlined in the status body
- Callbacks retry with backoff and dead-letter, with polling still available as a fallback

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — Answer slow work with a handle instead of a held connection {#fluency-api-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Idempotency](../../messaging/idempotency.md) — A client that never saw the 202 retries the submit, so the accept has to be safe to repeat
- [Queue-Based Load Leveling](../resilience/load-leveling.md) — The queue between accept and work is what lets a burst of submissions become depth instead of refusals
- [Claim Check](../../messaging/claim-check.md) — A large result leaves the status body and becomes a short-lived link the caller fetches
- [Correlation Identifier](../../messaging/correlation-identifier.md) — Over a broker the reply is matched by an echoed id, because there is no open connection to answer on
- [Agent2Agent](../coordination/a2a.md) — A delegated agent task is this pattern with a published state machine
- [Web-Queue-Worker](../../architecture/web-queue-worker.md) — A queued job needs a way to report back; the 202 and status link is that way.

**Alternative to**

- [Workflow Orchestration](../coordination/workflow-orchestration.md) — One operation with one terminal state, rather than a durable multi-step process with compensation

**Has variant**

- [Long Polling](../../messaging/long-polling.md) — Long polling is the held-request way to learn the result of the work.

**Often confused with**

- [Future / Promise](../../concurrency/future-promise.md) — A future is the in-process handle for a result not yet ready; this pattern is the same handle idea across a network boundary

**Prevents**

- [Busy Front End](../../../hazards/busy-front-end.md) — The front end accepts the work and hands back a handle, so no request thread is held while the job runs

**Implemented by**

- [Compute](../../../capabilities/compute.md) — Workflow engines return a handle at once and let the caller poll for the result.

<!-- relationships:end -->
