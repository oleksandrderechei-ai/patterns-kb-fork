---
title: LeetCode
description: "Run untrusted user code safely in under 5 seconds, and keep a 100k-user contest leaderboard live"
area: designs-advanced
owner: Oleksandr Derechei
tags: [security, isolation, asynchrony]
status: stable
aliases: [online judge, coding judge, code execution platform]
solves: [I have to run code that strangers submit without it deleting my data or mining crypto on my servers, one submission with an infinite loop pins the CPU and takes every other in-flight request down with it, recomputing a live leaderboard by scanning and sorting the whole submissions table on every poll is crushing my database, a burst of submissions during a contest overwhelms my workers and requests start timing out, spinning up a fresh sandbox for every job is too slow to hit my latency budget]
---

# LeetCode

An online judge lets an engineer read a coding problem, write a solution in the browser, and submit it for instant pass/fail feedback — with a live leaderboard during timed contests. It is a small system by the numbers, but it turns on one genuinely hard thing: executing arbitrary, untrusted code from strangers safely, fast, and at contest scale.

## Understanding the problem
<!--meta block=description-->

A coding-interview trainer lets users browse problems, write a solution, get graded against hidden tests within seconds, and watch a contest leaderboard update. Scale is modest, so browsing and storage are non-events. The hard question is how to run a stranger's program without handing them your servers; the page walks through sandboxed execution and the leaderboard.

## Explained
<!--meta block=explain-->

LeetCode grades a stranger's code safely in about 5 seconds, then keeps a contest ranking current for 100,000 people. The submit call returns an id at once and puts the code on a queue. Workers pull jobs and run each one in a locked-down container, a disposable box with no network, a read-only disk and capped CPU and memory. The client polls for the result. The ranking lives in a Redis sorted set, which holds each score in order, so a poll reads the top entries without touching the database. Choose containers over virtual machines because they start in milliseconds, and over serverless functions because cold starts eat the 5-second budget. Containers share the host kernel, so treat the hardening list as a deploy check. Polling adds round trips, and a ranking polled every 5 seconds lags by up to 5 seconds, which is fine. A worker that dies mid-run leaves its message undeleted, so the queue hands it to another worker.

**Example.** A contest peaks at 10,000 simultaneous submissions. Each runs about 100 test cases at 100 ms of CPU, so 10 s of CPU worst case. That is 100,000 CPU-seconds, so finishing in 60 s takes about 1,700 cores, and a single machine cannot hold that. Each language pool grows and shrinks instead. A user's poll first sees processing, then passed. The leaderboard polls every 5 s from 100,000 users, which is 20,000 reads a second against the sorted set, where a database sort over a million rows each time would stall. The cost is a 5 s lag in the ranking.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Browse a paginated list of problems and open one to see its full statement and a starter code stub.
2. Write a solution in one of several languages and submit it for grading against the problem's test cases.
3. Receive pass/fail feedback on a submission within a few seconds.
4. View a live leaderboard for a timed competition.

Out of scope: auth, profiles, payments, analytics, and social features. Users are assumed already authenticated, with a userId in the session — so identity never travels in a request body.

### Non-functional
<!--meta requirement=nfr-->

- **Isolation & security** — submitted code runs fully sandboxed; it cannot touch the host, the network, or other submissions.
- **Latency** — grading results returned within ~5&nbsp;seconds.
- **Availability** — favoured over strict consistency; a briefly stale leaderboard is fine, a dropped page is not.
- **Scale** — a contest must absorb up to 100,000 participants submitting in the same 90-minute window.

## Right-sizing
<!--meta block=sizing-->

**Storage is small.** ~4,000 problems, each a statement plus test cases and per-language stubs — kilobytes apiece. The whole corpus is a few tens of megabytes; it caches entirely in memory and the read path for browsing needs nothing clever.

**The real load is CPU, and it only appears during contests.** Take a contest of 100k users and a peak of ~10,000 simultaneous submissions. Each solution is graded against ~100 test cases at roughly 100&nbsp;ms of compute each — up to ~10&nbsp;s of CPU per submission in the worst case. That is CPU time, not wall-clock: the harness runs a submission's cases across the container's cores, so even the worst case lands inside the ~5-second result target, and a typical submission — a handful of cheap cases — is nowhere near either bound. That is 10,000 × 100 = **1,000,000 test-case runs ≈ 100,000 CPU-seconds** of work arriving in a burst. To clear it inside a minute you need on the order of **~1,667 cores** — far past any single machine. That is the burst drain target; a typical submission still returns in about 5 s. Finishing the whole peak in 5 s would take about 20,000 cores (100,000 CPU-seconds / 5), so at the peak results queue past 5 s unless the fleet is pre-scaled. A worst-case submission needs at least 2 cores in its container to fit 10 s of CPU into 5 s; the 1,667 cores are the fleet total.

The architecture's entire scaling story is the execution fleet, not the database. Everything else is small; the code runner is what has to be elastic.

## Core entities
<!--meta block=entities-->

Three entities carry the whole design:

- **Problem** — the statement, its `level` and `tags`, per-language `codeStubs`, and the `testCases` (input/expected-output pairs) nested as a subdocument.
- **Submission** — one attempt: the user's `code` and `language`, the problem it targets, and the grading `result` once it runs.
- **Leaderboard** — the standings for one competition: each participant's score and tie-break time.
- **User — implied, not modelled.** Identity comes from the authenticated session, so there is no need to name a User entity here; a submission just carries the userId the server reads from the session.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface. The list endpoint returns a trimmed projection (title, level, tags) rather than full statements, and grading is asynchronous — submit returns an id you poll:

```http summary="HTTP — browse, submit, poll, leaderboard"
GET  /problems?page=1&limit=100          → Partial<Problem>[]   (title, id, level, tags)
GET  /problems/:id?language=python        → Problem            (full statement + code stub)

POST /problems/:id/submit                 → { submissionId }
     body { "code": "...", "language": "python" }

GET  /check/:submissionId                 → Submission | { "status": "processing" }
GET  /competitions/:id/leaderboard?top=100 → Leaderboard
```

Note what is absent: no `userId` and no timestamps in any body or query string. Trusting a client-supplied identity or clock is the classic red flag — the userId is read from the session/JWT and every timestamp is generated server-side.

## How the system is built
<!--meta block=architecture-->

At this scale the reflex to reach for microservices is wrong; a plain stateless API server in front of a store is the right amount of machinery. The one exotic piece is the **execution path**. A stateless API server handles browsing and stores submissions in a NoSQL store (DynamoDB — no joins, and test cases nest naturally under a problem). Grading, though, never runs in the API process. A submission is enqueued; a fleet of **workers** pulls jobs and runs each one inside a **sandboxed, language-specific container** with the code, its test harness, and tight resource limits. The worker reads the container's output, writes the result back to the store, and — for contest problems — updates a **Redis sorted set** that serves the leaderboard. The client learns the outcome by polling.

```mermaid caption="Browsing is trivial; grading is the whole design — enqueue, pull, run sandboxed, write back, then the client polls for the result and the standings."
flowchart TB
    Client["Client · Monaco editor"]
    API["API server · stateless"]
    DB[("DynamoDB · problems + submissions")]
    Redis[("Redis sorted set · live leaderboard")]
    Queue["Submission queue"]
    Worker["Worker fleet · autoscaled"]
    Sandbox["Language container · sandboxed, resource-capped"]

    Client -->|"browse / open problem"| API
    Client -->|"POST submit"| API
    Client -->|"poll /check and /leaderboard"| API
    API -->|"read problems, store submissions"| DB
    API -->|"enqueue submission"| Queue
    Queue -->|"pull job"| Worker
    Worker -->|"run code, read output"| Sandbox
    Worker -->|"write result"| DB
    Worker -->|"add score"| Redis
    API -->|"read top N"| Redis
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Running a stranger's code without getting owned

This is the crux of the whole problem, and there is a wide gap between the naïve answer and a safe one.

- **In the API process (never).** Writing the code to a file and executing it in-process is a disaster on three axes at once. **Security:** the code can delete or exfiltrate data, mine crypto, or launch attacks from your infrastructure. **Performance:** a tight loop or memory leak pins the box. **Isolation:** a crash takes the whole server down and blocks every other request — there is no failure containment at all, which is exactly what a [bulkhead](../patterns/distributed/resilience/bulkhead.md) exists to provide.
- **Virtual machine.** Run each submission in a VM: a hypervisor gives each a full OS and strong isolation, and you can reset it if something goes wrong. Safe, but VMs are heavy and slow to start — expensive lifecycle management for a job that lasts seconds.
- **Container — this design's answer.** Containers share the host kernel and isolate at the process level, so they start fast and cost little — one image per runtime (Python, JavaScript, Java…), each carrying its dependencies. Cold-starting one per submission is still wasteful, so keep warm containers and reuse them across jobs, an [object pool](../patterns/gof/extra/object-pool.md) of ready runtimes; wipe or recycle a container between submissions so no state leaks across users. Sharing the kernel means the sandbox must be hardened deliberately: a read-only filesystem, CPU and memory caps that kill an over-budget container, a process-count cap against fork bombs, an output-size cap, no network access, and a seccomp profile whitelisting syscalls. A per-test-case [timeout](../patterns/distributed/resilience/timeout-deadline.md), on wall-clock as well as CPU, kills a runaway loop before it spends the latency budget. That is the [least privilege](../patterns/security/least-privilege.md) principle made concrete.
- **Serverless functions.** One function per runtime, auto-scaled by the platform. Tempting, but cold-start latency on the first invocation eats into a tight time budget and per-invocation resource caps constrain heavier submissions. With steady, predictable submission volume, containers win.

### 2 · Grading asynchronously, and scaling the fleet

Grading against ~100 test cases takes seconds, so the API cannot hold the connection open and hand back a result inline — that is what times out and fails to scale. Instead, submit returns a `submissionId` immediately and the client polls `GET /check/:id` until the status flips from processing to a result.

Between the API and the workers sits a queue. It does two distinct jobs. It [levels the load](../patterns/distributed/resilience/load-leveling.md): a contest's submission spike lands in the queue and drains at whatever rate the fleet can sustain, rather than overwhelming it. And it turns the workers into [competing consumers](../patterns/messaging/competing-consumers.md) — each pulls the next job when it has capacity, which is exactly the elastic pull model a bursty CPU workload wants, with retries if a container dies mid-run. A message is redelivered only if the worker leaves it undeleted, so set the visibility timeout above the longest grading time, cap delivery attempts, then move the message to a dead-letter queue and mark the submission failed. Key the result write and the ZADD by submissionId so a redelivery repeats nothing. The trade is added asynchrony and a little over-engineering for a system this size; if contests require registration you could pre-scale instead, but the queue buys spike tolerance and retry-on-failure cheaply.

For the fleet itself, vertical scaling is a dead end — the sizing math wants ~1,667 cores, far more than one machine holds. So each language pool scales horizontally, and an [autoscaler](../patterns/distributed/routing/autoscaling.md) grows and shrinks it on CPU utilisation. The real risk is scaling up too slowly: CPU utilisation lags a contest spike, so pre-scale at contest start and add queue depth as a second signal. Idle capacity is cheap and reversible.

### 3 · A leaderboard that stays live without melting the database

A contest is 90 minutes, 10 problems, up to 100k users; the ranking is problems-solved, ties broken by finish time. Clients poll roughly every 5 seconds.

- **Query on every poll.** Each poll runs a `GROUP BY userId … ORDER BY solved DESC, time ASC` over the submissions table. Across 100k users that is a scan-group-sort over up to a million rows every few seconds — it flattens the database precisely when the contest is hottest. Rejected.
- **Periodically refreshed cache.** Recompute the standings into Redis every ~30 s and let polls hit the cache. A big improvement, but the results are coarse and can lag reality by half a minute.
- **Redis sorted set (chosen).** Maintain the leaderboard as a live, precomputed projection — a [materialized view](../patterns/distributed/coordination/materialized-view.md) kept in a sorted set keyed `competition:leaderboard:{competitionId}`. On each accepted submission the worker does one `ZADD` with the user's score; a poll reads the top N with `ZRANGE … REV WITHSCORES` in O(log&nbsp;n + N), never touching the durable store. Both ranking keys fit one score: solved count times a large constant minus finish time, so `ZRANGE … REV` puts more solved first and the earlier finish ahead on ties. The database stays the source of truth for submissions; the sorted set is the fast read model. WebSockets were considered and rejected — with a 5-second freshness target and this user count, they are complexity the problem does not earn. Polling frequency is even tunable: tighten it near the finish, relax it otherwise.

The leaderboard is a read model: the worker writes it once per accepted submission and polls only read it.

```mermaid caption="How does a 5-second poll read standings without touching the durable store?"
sequenceDiagram
    participant W as Worker
    participant Z as Redis sorted set
    participant C as Client
    W->>Z: ZADD user's score (on accepted submission)
    loop every ~5 s
        C->>Z: ZRANGE REV WITHSCORES, top N
        Z-->>C: standings
    end
```

### 4 · One test suite, every language

You do not want to hand-write test cases per problem and per language. Author one canonical set of input/expected-output pairs per problem in a language-neutral serialization format, then give each runtime a thin harness that deserializes the input, calls the user's function, and compares its output against the expected value. A binary-tree input, for instance, serializes as a level-order (BFS) array like `[3, 9, 20, null, null, 15, 7]`; every language ships a matching `TreeNode`-style type alongside the user's code so the harness can rebuild the tree before invoking their solution. Define a serialization strategy once per data-structure type and every supported language reuses the same canonical cases.

```mermaid caption="How is a submission graded without holding the connection open — and what happens when a worker dies mid-run? Submit returns an id immediately; the client polls, and an undeleted queue message is redelivered."
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API server
    participant Q as Submission queue
    participant W as Worker
    participant S as Sandbox
    participant DB as DynamoDB
    C->>A: POST /submit
    A->>DB: store submission (processing)
    A->>Q: enqueue submissionId
    A-->>C: 202 submissionId
    Q->>W: pull job
    W->>S: run code against tests
    alt finishes within limits
        S-->>W: verdict + stdout
        W->>DB: write result
    else timeout or container crash
        S--xW: killed
        Q->>W: redeliver to another worker
    end
    C->>A: GET /check/id (poll)
    A->>DB: read status
    A-->>C: processing, then result
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Untrusted code runs contained — a crash, an infinite loop, or a hostile payload is caged in one disposable hardened container, not the API server; a shared-kernel escape is the residual risk.
- A queue plus autoscaled worker pools absorb a contest's submission burst and grade it elastically, with retries when a worker dies, bounded by a retry cap and a dead-letter queue.
- The leaderboard is near-real-time and cheap — O(log n) sorted-set writes and reads keep it off the database entirely.

### What it gives up
<!--meta polarity=con-->

- Asynchronous grading means the client must poll `/check` — more round-trips and moving parts than an inline response.
- The queue is arguably over-engineering for this scale; predictable, pre-scaled fleets could serve registered contests with less machinery.
- The sorted-set leaderboard is computed from submissions and must be updated in lockstep with them, and its 5-second polling is a deliberate not-quite-live compromise.
- Queue wait can break the 5 s target. At a 10,000-submission peak the queue drains in about a minute on 1,667 cores, so results lag past 5 s unless the fleet is pre-scaled.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — clear API endpoints and a data model, a working end-to-end flow that meets the functional requirements, and recognising that user code must be isolated — proposing at least one of container, VM, or serverless to run it.
- **Senior** — moves fast through the high-level design to spend real time on secure, isolated execution: compares container vs. VM vs. serverless and justifies a choice, names the hardening measures, and breaks out of box-drawing to explain how test cases actually run against a submission.
- **Staff+** — drives the whole conversation, keeps the design deliberately simple with a clear scaling path, volunteers the execution-fleet math and the queue/autoscaling trade-offs, and can defend why WebSockets and microservices are not worth it here.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Object Pool](../patterns/gof/extra/object-pool.md) — warm language containers are kept ready and reused across submissions instead of cold-starting one per job
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — a worker fleet pulls submissions off the queue, each grabbing the next job as its capacity frees up
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the submission queue absorbs a contest's spike and drains it at the fleet's sustainable rate
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — each language-specific container pool grows and shrinks on central processing unit (CPU) utilization to track contest load
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — the live leaderboard is a Redis sorted set updated on each accepted submission, not recomputed per poll
- [Least Privilege](../patterns/security/least-privilege.md) — the sandbox is stripped to a read-only filesystem, no network, capped CPU/memory, and a seccomp syscall whitelist
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — each submission runs in its own disposable container so a crash or hang can't take the application programming interface (API) server or other jobs down
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — a hard per-test-case timeout kills a runaway or infinite-loop submission and keeps grading inside the ~5-second result target

<!-- relationships:end -->
