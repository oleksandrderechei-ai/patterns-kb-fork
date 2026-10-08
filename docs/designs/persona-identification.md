---
title: Persona Identification & Sanction Check
description: "A long-running identity-and-sanctions flow that waits on people and vendors for days, yet never tells the client a wrong or half-finished verdict"
area: designs-advanced
owner: Oleksandr Derechei
tags: [event-driven, asynchrony, durability, error-handling, state-management]
status: stable
aliases: [KYC flow, identity verification pipeline, sanction screening, person identification flow, magic-link onboarding]
solves: [my flow status enum is tangled up with retry counts and worker bookkeeping, we write the new state then crash before publishing the event and the client never hears, a vendor callback arrives twice and the duplicate lands before we have written our own event, two workers picked up the same task and both called the paid vendor API, one forgotten client-id filter in a query could leak another tenant's data]
---

# Persona Identification & Sanction Check

A client starts a flow by providing an email address. The address's owner is invited to submit personal information and an ID photo, an external service verifies the ID, the verified person is screened against external sanction lists, and the result reaches the client on a webhook. Authentication, ID verification, sanction checks and email sending already exist, so this page designs everything between them. A flow spends most of its life waiting, days for a photo and hours for a vendor, while carrying regulated personal data that belongs to one client among many: being slow is acceptable, telling a client the wrong outcome or none is not. [The V2 page](persona-identification-v2.md) argues the same brief from the delivery contract (exactly-once effect and a deadline on every stall), where this page argues from the storage core.

## Understanding the problem
<!--meta block=description-->

A client starts an identity-and-sanctions flow for a person by email; an outside vendor verifies the ID, sanction lists screen the person, and the result reaches the client's webhook. The task gives no volumes, jurisdictions or data rules, so the requirements mark each assumption, and the page walks through a design whose waits are stored rows.

## Explained
<!--meta block=explain-->

This design checks a person's identity and screens them against sanction lists, a process that waits days on people and outside vendors. It stores every wait as a row in one Postgres database, never as an open connection. Each step of a flow commits three things in one transaction: the new state, an event owed to the client and the next task for a worker. Stateless workers claim tasks from that table, call the vendors and write results back. A sender then delivers each owed event to the client's webhook (a callback address the client registers), with the same event id on every repeat. Choose this over a message broker (a separate queue service) while volume is low, because a broker cannot share a transaction with the state change.

- **One writer.** A database outage stalls writes until the standby takes over, so keep a standby that confirms every commit.
- **One vault.** Personal data sits in one store, so give it separate credentials and keys.
- **Regional copies.** Each region needs its own full stack, so budget one stack per region.

**Example.** A client creates 10,000 flows a day. Each flow touches about 42 rows, so 10,000 times 42 is 420,000 writes a day, about 5 a second, or 10 at a busy peak. A person takes about 24 hours to submit, so around 10,000 flows sit parked at once. As open connections that would exhaust a pool, but as rows they cost storage only. The ID vendor goes down for 6 hours. Tasks wait, then run, and no result is lost. The cost is a single writer: if its database fails, every write stops until the standby is promoted.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

**Mandatory — the product promise**

- A client starts a flow via API or dashboard by providing an email address.
- A repeated create for the same open client-and-email pair returns the existing flow instead of starting a duplicate.
- The email's owner receives a single-use invitation link that expires after 48 hours.
- The person can request a fresh invitation link themselves if theirs expired.
- The submitted personal information and ID photo are verified through the given external ID-verification provider.
- Only after verification passes is the person screened against every external sanction list.
- The verdict waits for the slowest list, because a late answer beats a quietly partial one.
- The client receives the flow's result on a webhook.
- A result delivered more than once is recognisable to the client as a repeat of the same result.

**Additional — ongoing obligations and governance** {#requirements-h4-2}

- When a flow cannot proceed, the client is notified with a failure event.
- A concluded flow's sanction screening is re-run on a cadence set per jurisdiction.
- Identity is re-verified with a fresh document from the person when their ID expires or is revoked.
- A verdict changed by re-screening or re-verification is delivered to the client the same way as the first result.
- Every state transition is recorded, and any flow's full history can be reconstructed after the fact.
- A flow and its transitions can be viewed step by step in the dashboard.
- Personal data is kept in its own store, separate from the flow's operational data.
- Every access to personal data is recorded with who accessed it, when, and for what purpose.
- Each sanction list is marked blocking or advisory per jurisdiction.
- A flow whose blocking list cannot be reached is held until it answers.
- A flow whose advisory list cannot be reached concludes with the gap named in the result and a re-screen scheduled to close it.
- A client can record that its relationship with a person has ended.
- A closed relationship ends the person's recurring obligations and starts the retention clock.

{#requirements-ol-2}

### Non-functional
<!--meta requirement=nfr-->

- **Scale**
  - ~100 merchant onboardings a week today (assumed, not given; confirm first, since every capacity decision is priced against it); one merchant means several person-flows.
  - Headroom to 10k person-flows a day without redesign.
  - Recurring re-screening grows with the book of relationships still open, not with daily intake, and must never starve live flows.
  - Growth beyond that has named exits, not speculative ones.
- **Evolvability**
  - A deployment meeting only the mandatory requirements is a complete, correct product on its own.
  - Each additional obligation attaches to the recorded history of the mandatory flow without redesigning it.
  - A new jurisdiction or vendor changes configuration and cadences, not the shape of the system.
- **Consistency**
  - The flow's recorded state and what the client was told must never diverge across a failover; after a restore from the last archived segment (dive 4) the gap is bounded by the RPO stated in the runbook.
  - Behaviour is asynchronous end to end; when speed and correctness pull apart, correctness wins.
  - [Idempotency](../patterns/messaging/idempotency.md): a repeated or replayed input, whether a create, a vendor callback or a delivery, leaves the flow in the same state as its first arrival.
- **Latency**
  - Nothing is promised about how fast a verdict arrives, because the two slowest participants are a vendor and a human being.
  - Internal objectives, assumed rather than given: 99% of flows leave Awaiting ID Verification within 4 hours of the vendor accepting them, 99% of screening rounds close within 12 hours of fan-out, and 99.9% of client-visible events are delivered within 5 minutes of the transition that wrote them.
- **Availability & resilience**
  - The ID-verification vendor is down ~6 hours a week: work waits for it, and a vendor outage never fails a flow.
  - Stuck flows are detected and retried: an operator is paged within 15 minutes of a flow passing its state deadline, and the client receives a failure event within 5 minutes of that flow being declared stuck.
  - Every error path is explicit: a failed step retries, escalates, or ends the flow with a recorded reason, and nothing is silently dropped.
  - The system refuses new work rather than accepting work it cannot drain.
  - A database failover loses no acknowledged fact: a committed transition and the event owed to the client survive the switch.
- **Observability**
  - One flow id correlates every transition, vendor call and delivery attempt.
  - Alarms fire on stuck flows, backlog depth and per-vendor error rates.
  - Every alarm has a runbook: what it means, how to diagnose it, how to recover.
- **Compliance**
  - Verified documents are stored as evidence, not proxied; no evidence means no answer to an audit.
  - Name, date of birth and ID photo are GDPR personal data about people who are not our customers, so a cross-client leak is a reportable incident.
  - Personal data is encrypted at rest; right-to-forget is honoured and provable.
  - Retention is a per-jurisdiction policy enforced and evidenced by the system.
- **Security & tenancy**
  - Tenant isolation is enforced by the database itself, not by application filters alone.
  - Internal services and data stores are reachable only over a private network, never from the public internet.
  - Webhooks are authenticated; invitation links cannot be reused.
  - Each client belongs to a region recorded at onboarding, and their data, personal data and documents above all, stays in it.

### Out of scope {#requirements-outofscope}

- **Cancelling a flow in flight** — a started flow runs to a finished state or is abandoned.
- **Status polling in flight** — a flow idles for days between vendor calls, so live updates would report almost nothing; recovery is webhook replay plus the dashboard, not a second read path.
- **Human review of a possible match** — it happens on the client's side of the webhook; assumed, not given: each vendor returns a hit or a clear, never a raw match score.
- **Cross-region failover** — regional isolation for residency is in scope; surviving the loss of a region is not.

## Right-sizing
<!--meta block=sizing-->

**The problem:** a flow that waits days on people and vendors, ~75 person-flows a day today (assumed: ~100 merchant onboardings a week, ×5 person checks) against a design target of 10k a day. **The shape:** event-driven, decided by the waits and not by the volume: a request thread cannot be held for a day, a verdict must reach the client at least once across crashes, each repeat recognisable by its eventId, and the regulator asks for the history itself, so every wait is a durable row and every state change an appended event. Current state is materialised on the flow row instead of folded from the log on each read, because the audit duty wants append-only history and no requirement wants replay-on-read. **The stores:** four per region, operational Postgres (flows, history, queue, outbox, inbox), a separate encrypted vault for personal data, object storage for documents and a small [shared cache](../patterns/caching/distributed-cache.md) holding circuit-breaker state; residency makes each region a full stack, so every number below is per region and a new region multiplies stacks, not load.

### Required capabilities — what the shape above forces, before any product is named {#sizing-h-capabilities}

| Capability | Tier | What forces it | Routes to |
| --- | --- | --- | --- |
| **Durable transactional store** | mandatory | The state machine and its append-only history; a transition and its consequences commit together or not at all. | NFR: consistency |
| **Work queue** | mandatory | ID vendor down ~6 h/week, a person takes ~a day to submit; every step must be able to wait. | NFR: availability & resilience |
| **Coordination cache** | mandatory | One circuit-breaker record and one set of fallback weights per vendor, shared by every worker replica; also the rate-limit counters. | NFR: availability & resilience |
| **Rate limiting** | mandatory | Vendor quotas are finite and the self-serve resend must not become a mail cannon. | FR: invite resend; NFR: availability & resilience |
| **Object store** | mandatory | Documents kept as evidence, in the client's region. | NFR: compliance; security & tenancy |
| **Reliable webhook delivery** | mandatory | A repeat recognisable as a repeat. | FR: result delivery; NFR: consistency |
| **Private network** | mandatory | Internal services and stores unreachable from the public internet; only the API, dashboard and webhook egress face it. | NFR: security & tenancy |
| **Encrypted PII store with key custody** | additional | Its own credentials, one envelope key per person, held by a key manager the application cannot export. | FR: separate PII store, access audit; NFR: compliance |
| **Scheduler** | additional | Per-jurisdiction re-screening and re-verification cadences. | FR: re-screening, re-verification |

### The numbers — every figure is per region, and the largest region dominates {#sizing-h-numbers}

| Axis | How it is worked out | Result | Routes to |
| --- | --- | --- | --- |
| **Writes** | ~42 rows per flow (12 inserts: flow, person, document, link, ~5 transitions, ~3 outbox/inbox; ~8 task rows claimed and completed, so touched twice; ~8 `sanctions_check` writes; one row each for the verification session, the idempotency key and the delivery record; this is the floor with no retries, and each retry adds one task-row write) × 10k flows/day, ×2 for business-hours and campaign bunching. As a rule of thumb for one primary on commodity hardware, ~100/s is comfortable and 10k–50k/s is the ceiling, two rungs above this design. | **5 row-writes/s into Postgres**, **~10/s peak** | NFR: scale |
| **Storage** | ~1 KB metadata × 5 years; ID photos 2 MB × 10k/day held for 1-year retention, expired by lifecycle rule. | **18 GB** metadata, **7 TB** of photos | NFR: scale; compliance |
| **Waiting (Little's law)** | ~24 h mean submission wait. Inert rows the claim query never scans, resolved by the 48-hour link expiry and a scheduled [sweeper](../patterns/distributed/coordination/sweeper.md) that re-invites or escalates a failure event. | **~10k open flows** parked | NFR: consistency |
| **Re-screening load (additional tier)** | ~3.6M concluded persons after a year × quarterly cadence ≈ 40k re-checks/day, each fanning out a leg per sanction list (~160k legs/day) at ~10 row-writes per re-check (a transition, a task and a result per list, one outbox row). The book roughly doubles the write rate of live intake: a second workload of the same size, so the batch needs its own capacity story. | **~2 outbound vendor calls/s**, **4–5 row-writes/s into Postgres, sustained** | NFR: scale |
| **Sanctions [fan-out](../patterns/messaging/fan-out.md)** | ~4 lists × 10k flows/day ≈ 40k screening legs/day from live intake, plus about four times that from the re-screening book at steady state. | **0.5 vendor calls/s** from live intake; the binding limit is vendor quota, not compute | NFR: scale |
| **Vendor invoice** | ~200k vendor calls/day at steady state (40k live legs plus ~160k recheck legs), priced per call. Intake is flat by assumption while the recheck book grows with the customer base, so the invoice climbs even in a month nobody onboards. Watch both the monthly contracted cap and the run rate against it: compute headroom says nothing about either. | **~200k calls/day**, growing with the book; the first limit reached is commercial | NFR: scale; tradeoffs |

### Verdict per candidate — including the ones a bigger system would claim reflexively, so each is on the record {#sizing-h-verdicts}

| Candidate | Verdict | Reason | Routes to |
| --- | --- | --- | --- |
| **Synchronous request/response** | rejected | The person takes ~a day and the ID vendor is down ~6 h/week, so a thread or connection held per in-flight flow exhausts the pool at trivial concurrency. | NFR: availability & resilience |
| **Event-driven core** | adopted | Every wait is a durable row and every state change an appended transition, so the regulator's history is a by-product of running the flow, not a second write path that could disagree. | FR: history; NFR: consistency |
| **Work queue as a table in the system of record** | adopted | The task insert commits in the same transaction as the state change that spawned it, and `FOR UPDATE SKIP LOCKED` is a competent competing-consumers queue at ~10 writes/s. | NFR: consistency; availability & resilience |
| **Outbox and inbox** | adopted | The outbox closes the write-then-crash-before-publish gap that silently un-tells a client; the inbox dedups on the vendor's own request id, so a duplicate arriving before our first write still collides. | FR: result delivery; NFR: consistency |
| **Scheduler as a query on a cadence** | adopted | Both recheck clocks are due-dated rows a sweep picks up, so recurrence costs a predicate rather than a timer service. | FR: re-screening, re-verification |
| **Separate encrypted vault + key manager** | adopted | Erasure must be provable, so it is key destruction, not a delete; separate credentials keep a compromised API tier from reading personal data. | NFR: compliance; security & tenancy |
| **Object store** | adopted | Evidence and residency force it; at 7 TB of immutable blobs it is also the cheapest place they could live. | NFR: compliance |
| **Coordination cache** | adopted | Correctness, not speed: per-process breakers make N replicas absorb N× the vendor's failures, then send N probes at a recovering vendor. | NFR: availability & resilience |
| **Synchronous in-region standby** | adopted | It is the single writer's failover, not a read path: the standby acknowledges every commit before the client does, so promotion loses no acknowledged fact. | NFR: availability & resilience |
| **Asynchronous replica** | rejected | It can acknowledge a commit the standby never received, and the fact lost would be the outbox row the client was already promised. | NFR: availability & resilience |
| **Read cache** | rejected | 18 GB of metadata, dashboard reads by primary key, no hot set worth a second copy to invalidate. | FR: flow view |
| **Search index** | rejected | The dashboard answers "show me this flow", never "find flows matching text". | FR: flow view |
| **Cache with a time to live (TTL) as the invite-link store** | rejected | The 48-hour expiry must trigger a re-invite, tell an expired link from an unknown one, and be spent by rowcount in the transaction that records the document, so it is a predicate on a durable row rather than an eviction; ~20k live rows gain nothing by moving. | FR: invite resend; NFR: consistency |
| **Message broker** | deferred | It would trade away the shared transaction to solve throughput this system does not have. **Trigger:** measured task-table churn, roughly sustained 100k flows/day. | NFR: scale |
| **Workflow engine** | deferred | A state column plus a transitions table already gives durable, inspectable orchestration. **Trigger:** flow variants multiplying, priced at losing the append-only history to the engine's own. | NFR: evolvability |
| **Read replica** | deferred | **Trigger:** dashboard and reporting reads competing with worker claims. | NFR: scale |

### When this stops being right → NFR: scale {#sizing-h-limits}

The queue-in-Postgres wears out first. Every update leaves a dead copy of the row behind for a background cleanup (autovacuum) to reclaim, and each task row is written three times: claimed, retried, completed. Past the broker trigger above, roughly 100k flows a day sustained (about 50 row-writes/s at ~42 rows per flow), the garbage outruns the cleanup, the `task` table bloats and the claim query slows. **The signal: dead-tuple ratio on `task` and age of the oldest pending row, climbing together.** The exits in order, each priced above: index and prune the task table, add a read replica, move the queue to a broker (the outbox survives untouched), then shard by `client_id`, which also pins a client's rows to its region. All are safely deferred, because resilience is bought by protocol, not infrastructure.

## Core entities & data design
<!--meta block=entities-->

The schema keeps two things apart so that no convention has to: business truth (`flow` and its append-only `flow_transition` history) never mixes with operational bookkeeping (`task` attempts, locks and backoff), and personal data lives in a separate vault the operational store references only by opaque id. A flow's current state, one of five, is materialised on its own row so reading it is a primary-key lookup, while every transition into it is appended and never rewritten, so the audit view is a [projection](../patterns/distributed/coordination/materialized-view.md) over those rows and not a second write path. Four constraints do most of the work: the partial unique index `one_open_flow` is the duplicate-invite rule, the inbox's three-column uniqueness is the callback dedup (dive 3), `idempotency_key`'s composite primary key is the client-retry guard, and `delivery_cursor`'s one row per flow is the ordering guarantee.

### Tenancy & identity — operational Postgres + PII vault {#entities-group-1}

- **Client** — The tenant. Every client-scoped table carries `client_id`, and row-level security makes the tenant filter impossible to forget.

  ```sql summary="schema — client"
  CREATE TABLE client (
    id                 uuid PRIMARY KEY,
    region             text NOT NULL,     -- recorded at onboarding; PII and documents stay in it
    webhook_url        text NOT NULL,
    webhook_secret_ref text NOT NULL      -- points into the secret store, never the secret itself
  );

  -- The same three lines on every client-scoped table. FORCE is the load-bearing one: ENABLE
  -- alone is bypassed by the table owner, so the application also connects as a NON-OWNER role.
  ALTER TABLE flow ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flow FORCE  ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON flow
    USING (client_id = current_setting('app.client_id')::uuid);
  -- SET LOCAL, never SET: the setting dies with the transaction, so a pooled connection
  -- cannot carry one tenant's identity into the next checkout (dive 7).
  ```
- **Person** — Email and submitted personal data, encrypted under a per-person envelope key. Lives in the vault, referenced by id only; erasure destroys the key.

  ```sql summary="schema — person"
  -- In the encrypted vault: a separate store with its own credentials, one per region.
  CREATE TABLE person (
    id             uuid PRIMARY KEY,      -- the person_ref the operational store carries
    client_id      uuid NOT NULL,
    encrypted_data bytea NOT NULL,        -- email + submitted personal data, sealed as one blob
    key_id         text  NOT NULL         -- per-person envelope key, held by the key manager
  );
  -- Right-to-forget = destroy the key named by key_id; the blob becomes noise (dive 6).
  ```
- **MagicLinkKey** — Hash of the invite key: 48-hour expiry, single-use, superseded by a resend. Expiry is a predicate the redemption query reads, never a store TTL (time to live), because an evicted key reads as a forged one and the sweeper needs the row to re-invite from.

  ```sql summary="schema — magic_link_key"
  CREATE TABLE magic_link_key (
    key_hash       bytea PRIMARY KEY,   -- SHA-256 of a 256-bit CSPRNG token; never the token
    client_id      uuid NOT NULL REFERENCES client(id),  -- so the same RLS policy covers it
    flow_id        uuid NOT NULL,
    expires_at     timestamptz NOT NULL,  -- issued_at + 48h; a predicate, not an eviction
    used_at        timestamptz,           -- spent when the DOCUMENT lands, not at submit
    invalidated_at timestamptz            -- superseded by a resend: a different fact from spent
    -- … issued_at …
  );
  -- Redemption is one conditional UPDATE checked by ROWCOUNT, never read-then-write:
  --   … WHERE key_hash = $h AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now();
  -- Zero rows tells expired from forged from spent; two concurrent redemptions cannot both win.
  -- Spent and expired rows are deleted by the retention sweep, on the jurisdiction's clock.
  ```
- **PersonRelationship** — What the recurring obligations hang off, and the only thing that ever ends them. Retention counts from `closed_at`, which is why an object-store lifecycle rule cannot be the retention policy.

  ```sql summary="schema — person_relationship"
  CREATE TABLE person_relationship (
    client_id       uuid NOT NULL REFERENCES client(id),
    person_ref      uuid NOT NULL,
    opened_at       timestamptz NOT NULL,
    closed_at       timestamptz,         -- set by the client; ends every recurring obligation
    rescreen_due_at timestamptz,         -- NULLed on close, so the clock stops finding the row
    reverify_due_at timestamptz,         -- likewise
    retain_until    timestamptz,         -- computed FROM closed_at, not from the last check
    PRIMARY KEY (client_id, person_ref)
  );
  -- NULLing the two due dates on close is the whole termination rule (dive 6).
  ```

### Flow lifecycle — operational Postgres {#entities-group-2}

- **Flow** — The unit a client starts: current business state (the five-state model's enum, nothing else), an opaque reference into the PII vault, an optimistic-lock version.

  ```sql summary="schema — flow"
  CREATE TYPE flow_state AS ENUM (
    'initiated', 'awaiting_submission', 'awaiting_id_verification', 'awaiting_sanctions_check',
    'clear', 'cleared_with_caveat', 'sanctioned', 'invalid_id',  -- the finished branch
    'expired');                                    -- abandoned: the sweeper's final state
  -- 'cleared_with_caveat' is its own finished state because the client acts differently on it: every
  -- BLOCKING list reported and an ADVISORY one could not be reached (dive 3).

  CREATE TABLE flow (
    id          uuid PRIMARY KEY,
    client_id   uuid NOT NULL REFERENCES client(id),
    person_ref  uuid NOT NULL,                -- opaque ref into the PII vault
    email_mac   bytea NOT NULL,               -- HMAC under a per-region key that erasure also destroys
    state       flow_state NOT NULL DEFAULT 'initiated',
    version     int NOT NULL DEFAULT 0        -- optimistic check on every transition
    -- … timestamps …
  );

  -- At most ONE open flow per (client, email); a second create finds this index.
  CREATE UNIQUE INDEX one_open_flow ON flow (client_id, email_mac)
    WHERE state NOT IN ('clear', 'cleared_with_caveat', 'sanctioned', 'invalid_id', 'expired');
  -- 'expired' is why that state exists: an abandoned flow never reaches a finished state on its own,
  -- so without it the pair stays open for ever and every repeated create returns a dead flow.
  ```
- **FlowTransition** — Append-only history of every state change. The state machine is the source of truth; the audit view is a projection over this table, never a second place to write. {#entities-entity-5}

  ```sql summary="schema — flow_transition"
  CREATE TABLE flow_transition (        -- append-only; the audit view projects from here
    flow_id        uuid NOT NULL,
    seq            int  NOT NULL,
    from_state     flow_state,
    to_state       flow_state NOT NULL,
    cause          text NOT NULL,       -- 'idv_passed', 'list_hit:ofac', 'sanctions_recheck', …
    provider       text,                -- WHICH vendor answered: the fallback is not the default
    policy_version text,                -- to WHAT standard, at the time it ran (stamped by the ACL, dive 3)
    at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (flow_id, seq)
  );
  ```
- **Task** — The work queue. All operation state lives here — pending/processing, attempts, locks, run-after — and none of it ever touches the Flow enum. {#entities-entity-6}

  ```sql summary="schema — task"
  CREATE TABLE task (                   -- ALL operation state lives here, not on flow
    id           bigserial PRIMARY KEY,
    flow_id      uuid NOT NULL,
    kind         text NOT NULL,         -- send_invite | verify_id | check_list:<list> | deliver_webhook
                                        -- | await_callback:<vendor> (dive 4)
    status       text NOT NULL DEFAULT 'pending',   -- pending | processing | done | dead
    attempts     int  NOT NULL DEFAULT 0,
    max_attempts int  NOT NULL DEFAULT 8,  -- the budget; without it, poison retries for ever
    last_error   text,                     -- what an operator opens a dead task to read
    run_after    timestamptz NOT NULL DEFAULT now(),  -- backoff WITH jitter lands here
    locked_by    text,
    locked_at    timestamptz
  );
  ```

### Verification evidence — operational Postgres + object store {#entities-group-3}

- **Document** — The ID photo's metadata row, written before the presigned upload so a failed upload leaves a visible stub, never an orphan blob. Bytes live in object storage.

  ```sql summary="schema — document"
  CREATE TABLE document (
    id          uuid PRIMARY KEY,
    person_ref  uuid NOT NULL,
    storage_key text NOT NULL,          -- row FIRST, then presigned upload → no orphan blobs
    uploaded_at timestamptz             -- NULL = upload never completed; sweeper notices
  );
  ```
- **VerificationSession** — One verification attempt, carrying the verified document's expiry date, which the re-verification clock reads.

  ```sql summary="schema — verification_session"
  CREATE TABLE verification_session (
    id              uuid PRIMARY KEY,
    flow_id         uuid NOT NULL,
    document_id     uuid NOT NULL REFERENCES document(id),
    result          text,                 -- NULL while the vendor works
    doc_expires_on  date,                 -- what the re-verification clock reads
    reverify_due_at timestamptz           -- due-dated row the scheduler sweep picks up
    -- … provider, timestamps …
  );
  ```
- **SanctionsCheck** — One row per sanction list, the [Scatter-Gather](../patterns/messaging/scatter-gather.md) legs the collector joins. Its outcome is three-valued so a list nobody can reach still ends, and its due date is the re-screening clock.

  ```sql summary="schema — sanctions_check"
  CREATE TABLE sanctions_check (
    flow_id        uuid NOT NULL,
    round          int  NOT NULL,          -- issued by the transition that fanned out
    list           text NOT NULL,          -- one leg per sanction list
    outcome        text,                   -- NULL while pending; hit | clear | unavailable
    recheck_due_at timestamptz,            -- per-jurisdiction cadence; the sweep's predicate
    PRIMARY KEY (flow_id, round, list)     -- round, or a re-screen counts January's answers
    -- … checked_at, provider, policy_version …
  );
  -- The collector counts FINAL OUTCOMES within its round (dive 3):
  --   SELECT count(*) FROM sanctions_check
  --   WHERE flow_id = $flow AND round = $round AND outcome IS NOT NULL;
  -- A leg's outcome is recorded UNCONDITIONALLY, never guarded on the flow's state:
  INSERT INTO sanctions_check (flow_id, round, list, outcome)
  VALUES ($flow, $round, $list, $outcome)
  ON CONFLICT (flow_id, round, list) DO UPDATE
    SET outcome = excluded.outcome
    WHERE sanctions_check.outcome IS DISTINCT FROM 'hit';  -- a hit is never overwritten
  ```

### Integration & delivery — operational Postgres {#entities-group-4}

- **Outbox** — One row per event the client must hear about, written in the same transaction as the transition that caused it.

  ```sql summary="schema — outbox"
  CREATE TABLE outbox (
    id           bigserial PRIMARY KEY,
    flow_id      uuid NOT NULL,
    event_id     uuid NOT NULL UNIQUE,  -- the client's dedup key, stable across retries
    seq          int NOT NULL,          -- this flow's own order; the dispatcher sends by it
    payload      jsonb NOT NULL,
    published_at timestamptz,           -- NULL = still owed to the client
    UNIQUE (flow_id, seq)
  );
  ```
- **DeliveryCursor** — One lane per flow, and the reason two results cannot arrive out of order. The dispatcher claims a flow rather than an event, and sends only the next sequence that flow owes.

  ```sql summary="schema — delivery_cursor"
  CREATE TABLE delivery_cursor (
    flow_id       uuid PRIMARY KEY,
    client_id     uuid NOT NULL REFERENCES client(id),
    delivered_seq int NOT NULL DEFAULT 0,  -- the last seq this client has 2xx'd
    attempts      int NOT NULL DEFAULT 0,
    run_after     timestamptz NOT NULL DEFAULT now(),
    locked_by     text                     -- one dispatcher per flow, never two
  );
  -- Advance only on a 2xx. A flow in backoff blocks its own lane and nobody else's (dive 3).
  ```
- **Inbox** — One row per vendor callback, inserted in the same transaction as the callback's effect.

  ```sql summary="schema — inbox"
  CREATE TABLE inbox (                  -- vendor callbacks, deduped at the boundary
    flow_id             uuid NOT NULL,
    step                text NOT NULL,
    provider_request_id text NOT NULL,  -- the VENDOR's id: collides even before our outbox write
    received_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (flow_id, step, provider_request_id)
  );
  ```
- **IdempotencyKey** — The client-inbound retry guard, one row per tenant, route and key. The insert is the lock: a concurrent retry either creates the row and owns the work, or collides and replays the stored response.

  ```sql summary="schema — idempotency_key"
  CREATE TABLE idempotency_key (        -- client retries only; vendors dedup via inbox
    client_id     uuid NOT NULL REFERENCES client(id),
    endpoint      text NOT NULL,        -- a key is unique per tenant AND per route
    key           text NOT NULL,        -- the client's opaque value, never parsed
    request_hash  bytea NOT NULL,       -- digest, not the body: the email stays in the vault
    status        text NOT NULL,        -- in_progress | completed
    lease_until   timestamptz,          -- in_progress only: the sweeper reclaims past this
    response_code int,                  -- replayed verbatim, so a retry is byte-identical
    response_body jsonb,
    expires_at    timestamptz NOT NULL, -- 24h; must outlast the client's own retry budget
    PRIMARY KEY (client_id, endpoint, key)
  );
  ```
- **WebhookDelivery** — Per-attempt delivery record: what was sent, when, and what the endpoint answered.

  ```sql summary="schema — webhook_delivery"
  CREATE TABLE webhook_delivery (
    id              bigserial PRIMARY KEY,
    outbox_id       bigint NOT NULL REFERENCES outbox(id),
    attempt         int NOT NULL,
    response_status int,                  -- NULL = no answer before timeout
    sent_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outbox_id, attempt)
  );
  ```

### Governance — operational Postgres {#entities-group-5}

- **AuditLog** — The compliance papertrail of PII access: who read what, when, why. Flow history it does not duplicate; that is FlowTransition's projection.

  ```sql summary="schema — audit_log"
  CREATE TABLE audit_log (              -- append-only; PII access only, never flow history
    id         bigserial PRIMARY KEY,
    actor      text NOT NULL,           -- who: operator or service principal
    person_ref uuid NOT NULL,           -- what
    purpose    text NOT NULL,           -- why: 'support_case:1234', 'regulator_export'
    at         timestamptz NOT NULL DEFAULT now()
  );
  ```

## The interface — API design
<!--meta block=interface-->

Every client-facing state-changing call returns 202, because work is recorded durably and done asynchronously; the one exception is the onboardee's submission, a 201 carrying the presigned upload URL it just created. There is no single idempotency mechanism: each boundary carries its own guard, held by the side that can see the duplicate, so every endpoint below names the one it relies on. Admission control is part of the contract: when the live class's oldest pending task passes its ceiling, `POST /flows` answers 429 with a `Retry-After`, because accepting a flow into a queue hours behind is a promise the system cannot keep (dive 1).

### Client API — authenticated tenant calls {#interface-group-1}

- **`POST /flows`** — Start a flow from an email. Two guards against two different duplicates: the stored `Idempotency-Key` absorbs the client's network retry, and `one_open_flow` absorbs a genuinely repeated invite. {#interface-endpoint-1}

  ```http summary=contract
  POST /flows
  Idempotency-Key: 7c9e-4b1a-…                     client-generated UUID, opaque to us
  { "email": "jane@example.com" }                  the verdict goes to the client's registered webhook_url

  202 Accepted
  { "flowId": "flow_9c31", "state": "initiated" }

  # Same key, completed  → the stored 202 replayed, byte-identical.
  # Same key, in flight  → 409 Conflict + Retry-After: never a second execution.
  # Same key, other body → 422: the request_hash mismatch stops a client serving itself
  #                        the result of a different request.
  # DIFFERENT key, same email → 200 with the EXISTING open flow (one_open_flow).

  429 Too Many Requests    Retry-After: 900
  # Admission control, distinct from the per-client rate limit: the live class's oldest
  # pending task is past its age ceiling, so the system refuses work it cannot drain.
  ```
- **`POST /flows/{id}/invite/resend`** — Invalidate prior keys and issue a fresh single-use magic link with a new 48-hour expiry; reachable from the onboardee's resend page as well as by the client. It most needs the stored key: a retried resend would otherwise invalidate the link it just issued and send a second email. {#interface-endpoint-2}

  ```http summary=contract
  POST /flows/flow_9c31/invite/resend
  Idempotency-Key: b41f-90ac-…                     without it, a retry invites twice

  202 Accepted
  # Prior keys get invalidated_at, ONE fresh key is issued, the email goes out as a task.
  # Costs only a rate-limit token, so it is safe behind the resend page.

  409 Conflict   { "error": "already submitted" }   nothing left to invite
  409 Conflict   { "error": "retry in progress" }   same key, first call still running
  ```
- **`POST /flows/{id}/webhook/replay`** — Re-emit a missed result from the outbox with the same `eventId`: the recovery path that replaces polling. It takes no `Idempotency-Key`, because the `eventId` already guards the delivery and a replay is repeatable by construction. {#interface-endpoint-3}

  ```http summary=contract
  POST /flows/flow_9c31/webhook/replay

  202 Accepted
  # Re-emits the flow's final event with the SAME eventId, so the client's dedup absorbs
  # it whether or not the original ever arrived (dive 12, Q8).

  409 Conflict   { "error": "flow not finished" }   nothing to replay yet
  ```
- **`POST /persons/{ref}/relationship:close`** — The client records that the relationship ended, and every recurring obligation for that person stops. It is the only thing that bounds the recurring book, and the cheapest lever on the vendor bill. {#interface-endpoint-4}

  ```http summary=contract
  POST /persons/prs_7d02/relationship:close
  Idempotency-Key: 3ac0-…

  202 Accepted
  { "closedAt": "2026-08-01T09:14:00Z", "retainUntil": "2031-08-01" }

  # One transaction: stamp closed_at, NULL rescreen_due_at and reverify_due_at, and set
  # retain_until from now() on the jurisdiction's schedule (dive 6).
  # Idempotent by construction, so the Idempotency-Key is belt to the braces.
  # A flow already in flight for that person runs to its finished state.

  409 Conflict   { "error": "no open relationship" }   nothing to close
  ```

### Dashboard reads — the human read path {#interface-group-2}

- **`GET /flows/{id}/transitions`** — The read surface behind the step-by-step dashboard view: a projection over `flow_transition` under the same RLS tenant session as every other call. Reads are by primary key, and the list variant pages by cursor for support triage. Rendering a vault field is a PII access like any other and lands in `audit_log`.

  ```http summary=contract
  GET /flows/flow_9c31/transitions

  200 OK
  {
    "flowId": "flow_9c31",
    "state":  "awaiting_sanctions_check",
    "transitions": [
      { "seq": 1, "to": "awaiting_submission",      "cause": "invite_sent", "at": "…" },
      { "seq": 2, "to": "awaiting_id_verification", "cause": "submitted",   "at": "…" },
      { "seq": 3, "to": "awaiting_sanctions_check", "cause": "idv_passed",  "at": "…" }
    ]
  }
  # GET /flows?state=…&cursor=… pages by primary key; there is no free-text search.
  # Personal fields render only through the vault, and each read appends an audit_log row.
  ```

### Onboardee surface — the magic-link token is the identity {#interface-group-3}

- **`POST /submissions`** — Submit personal info against the magic-link session: that token is the onboardee's entire identity, there being no account, and it authorises this one flow's submission and nothing client-scoped. Returns a presigned upload URL for the ID photo; on `410` the onboardee sees the resend page, not a support address.

  ```http summary=contract
  POST /submissions
  Authorization: Bearer <magic-link token>         hash looked up, checked by rowcount
  { "personalInfo": { … } }

  201 Created
  { "uploadUrl": "https://blob.example/id-photos/…?sig=…", "expiresIn": 900 }
  # The document row is written BEFORE the URL is issued, so an abandoned upload leaves a
  # visible stub, never an orphan blob. The photo goes straight to object storage.
  # The URL is scoped to one object key, an image content type and a size cap.
  # The link is spent when the upload-complete event stamps document.uploaded_at, not here,
  # so a failed PUT consumes nothing and the retry works (dive 7).

  409 Conflict   { "error": "already submitted" }   the document for this key already landed
  410 Gone       { "error": "invite expired" }      show the self-serve resend
  ```

### Vendor callbacks — deduped at the boundary {#interface-group-4}

- **`POST /callbacks/{provider}`** — One inbound surface for IDV and sanctions-list callbacks, deduped on the vendor's own request id. The inbox's three-column uniqueness is the guard, so redelivery is always safe.

  ```http summary=contract
  POST /callbacks/idv-provider
  X-Signature: sha256=…                            vendor-authenticated, private ingress
  { "requestId": "req_88a1",                       the VENDOR's id: the dedup key
    "flowId":    "flow_9c31",
    "result":    "passed" }

  202 Accepted
  # The inbox row and the callback's effect commit in one transaction (dive 3).
  # A duplicate gets the same 202, so the vendor retries freely.
  ```

### Outbound — the webhook the client receives {#interface-group-5}

- **`POST {client.webhook_url}`** — The result and failure events, at-least-once, to the endpoint the client registered at onboarding, HMAC (hash-based message authentication code)-signed with the per-client secret. `eventId` is the client's dedup key, stable across retries and replays.

  ```http summary=contract
  POST https://client.example/hooks/kyc
  X-Signature: sha256=…                            HMAC of the body, per-client secret
  X-Signature-Key: whsec_2                         which secret signed; rotation dual-signs
  {
    "eventId":    "evt_4f21",                      STABLE: the client's dedup key
    "flowId":     "flow_9c31",
    "seq":        7,                               this flow's own order; discard anything older
    "state":      "cleared_with_caveat",           clear | cleared_with_caveat | sanctioned | invalid_id
    "caveats": [                                   ONLY on cleared_with_caveat: the advisory
      { "list": "eu_consolidated",                 list that went unanswered and when we
        "reason": "unavailable",                   will try it again
        "retryDueAt": "2026-07-21T09:00:00Z" }
    ],
    "occurredAt": "2026-07-20T14:33:48Z"
  }
  # SLA-breach escalations arrive as a distinct failure event type on the same channel.
  # At-least-once: non-2xx → retry with backoff → dead task + alert; the event stays
  # replayable with the SAME eventId. Order is separate from dedup: one flow's events go
  # out one at a time in seq order (dive 3).
  ```

### Governance — right-to-erasure {#interface-group-6}

- **`DELETE /persons/{id}`** — Crypto-shred the vault entry and purge the photo; the flow's non-PII history remains.

  ```http summary=contract
  DELETE /persons/prs_7d02

  202 Accepted
  # Runs as a task: destroy the envelope key, purge the photo, keep the non-PII history.
  # The access itself lands in audit_log: who, when, 'erasure_request' (dive 6).

  404 Not Found                                    unknown or already erased
  ```

## How the system is built
<!--meta block=architecture-->

Everything public enters through one door: clients create, replay and erase through the Identification API, onboardees reach it through a single-use magic link, and vendors call back into it. The one structural decision is that **the core is a persisted state machine on Postgres: every wait is a durable row, never an open connection**, because the human takes a day to submit, the ID vendor is down ~6 hours a week, and a connection held per in-flight flow would exhaust the pool at trivial concurrency. The write path commits a transition and all its consequences in one transaction; the stateless Worker fleet claims the resulting tasks and calls the vendors, and its dispatcher drains the outbox into signed webhooks. Dive 8 walks one clean flow through it in order.

```mermaid caption="Who talks to whom, and where does truth live? One database holds every kind of row, the stateless fleet works off it, and dashed boxes are the given externals."
flowchart TB
    C["Client"] -->|"create · replay · erase"| API["Identification API — behind the API gateway · stateless, RLS session per tenant"]
    U["Onboardee"] -->|"magic link · submit"| API
    U -->|"presigned PUT — ID photo"| BL[("Object store · claim-check")]
    API ==>|"ONE txn: transition + outbox + inbox + tasks"| PG[("Postgres — flow, transition, task, outbox, inbox")]
    API -->|"personal data, own credentials"| VAULT[("PII vault — separate encrypted store")]
    WK["Worker fleet — vendor pools, dispatcher, sweeper · competing-consumers"] -->|"claim tasks · drain outbox · sweep stuck"| PG
    WK -->|"consult breaker + weights"| CACHE[("Shared cache · circuit-breaker")]
    WK -->|"call"| V["IDV · Sanction lists · Email"]:::ext
    V -.->|"callback → inbox"| API
    WK -->|"HMAC-signed event → client endpoint"| C
    classDef ext stroke-dasharray:4 4;
```

### Components & communication {#architecture-h-components}

| Component | Role, and what it talks to |
| --- | --- |
| **Identification API** | The single public entry point: client calls, onboardee submissions via magic link, vendor callbacks. An [API gateway](../patterns/distributed/routing/api-gateway.md) fronts it, terminating TLS, authenticating the tenant and enforcing per-client and per-flow limits (the [rate limiter](../patterns/distributed/resilience/rate-limiter.md) that keeps the resend endpoint from becoming a mail cannon). Its only job is to commit facts (a transition, its outbox event, its follow-up tasks) in one transaction, statelessly, with a row-level-security session per tenant. |
| **Postgres** | The system of record and the queue: flow, its append-only transition history, task, outbox, inbox. Every guarantee on this page is one of its constraints or transactions. |
| **PII vault** | A separate encrypted store with its own credentials, reached only through `person_ref`, so a compromised API tier holds references rather than personal data. |
| **Worker fleet** | Stateless replicas around the database, no worker holding state, so capacity is a replica. One pool per vendor claims tasks with `FOR UPDATE SKIP LOCKED`. The dispatcher claims a **flow** rather than an event and drains its owed events in outbox order into HMAC-signed webhooks. The sweeper and both recheck clocks re-queue expired locks, dead-letter exhausted tasks, escalate overdue flows and re-enter concluded flows on each jurisdiction's cadence, each holding a lease in the shared cache so a second replica waits instead of double-firing. Pools read the list roster, criticality, cadences and quotas from a config store (dive 2) and write per-vendor error rate and latency to a metrics store that serves both the alerts and the fallback weights (dives 4 and 5). |
| **Shared cache** | Breaker state, fallback weights and the schedulers' leases, consulted before every vendor call. Coordination, not a read cache: every replica sees the same open circuit and the same lease holder. |
| **Object store** | ID photos, uploaded straight from the onboardee by presigned URL; workers pass the storage key, never bytes, and lifecycle rules back up retention. |
| **IDV · sanction lists · email, and the client's webhook endpoint** | The given externals. Vendors are consumed behind per-vendor pools and re-enter through the inbox; the client endpoint receives at-least-once, HMAC-signed events with a stable `eventId`. |

### Where each requirement lands — one row per functional requirement, in the requirements block's order {#architecture-h-trace}

Every path names only components on the board above.

| Requirement | Where it lands | FR |
| --- | --- | --- |
| Start a flow by API or dashboard with an email | Client → Identification API → Postgres: flow row, invite task and outbox event in one transaction. | start |
| A repeated create for an open pair returns the existing flow | The `one_open_flow` partial unique index in Postgres, not application logic. | no duplicates |
| A single-use invitation that expires after 48 h | Invite task → Worker fleet (email pool) → email vendor; the key is stored only as a hash, with its expiry. | invitation |
| Self-serve re-invitation | An Identification API endpoint invalidates prior keys and issues a fresh one, behind the gateway's per-flow limit. | re-invite |
| Verification through the given provider | Worker fleet (IDV pool) → vendor; the callback re-enters through the API into the inbox and drives a guarded transition. | verify |
| Sanctions only after verification passes | The state machine gates it: the fan-out tasks are written only by the transition into Awaiting Sanctions Check. | screen after verify |
| The verdict waits for the slowest list | The collector in the Worker fleet transitions only when every leg holds a final outcome. | slowest list |
| The result on a webhook | Outbox row → Worker fleet (dispatcher) → client endpoint. | result |
| A repeated delivery is recognisable | The stable `eventId` on the outbox row travels with every redelivery. | recognisable repeat |
| Failure reaches the client | The sweeper escalates through the same outbox path as any result. | failure event |
| Re-screening on a per-jurisdiction cadence | The recheck clock re-enters a Clear flow at the screening step, skipping any flow a newer one has superseded. | re-screen |
| Re-verification when a document expires or is revoked | The second clock re-enters at the invite, because only the person can supply a new document. | re-verify |
| A changed verdict is delivered like the first | The re-entered flow exits through the same outbox → dispatcher → webhook path. | changed verdict |
| Every transition recorded, any history reconstructible | `flow_transition` is append-only in Postgres; the audit view is a projection over it. | history |
| Step-by-step dashboard view | The dashboard reads that same transition history through the API. | dashboard |
| Personal data in its own store | The PII vault behind `person_ref`; photos in the Object store. | PII separation |
| Every access to personal data recorded | Each vault read appends who, when and why to the papertrail. | access log |
| Each list is blocking or advisory | The list roster in the config store carries each list's `criticality` per jurisdiction. | list criticality |
| A blocking list that cannot be reached holds the flow | The sweeper stamps an exhausted leg `unavailable`; the collector reads `criticality` and holds the flow and escalates. | blocked flow |
| An advisory list that cannot be reached concludes with the gap | The collector concludes `cleared_with_caveat`, names the gap in the outbox event and schedules a re-screen. | caveated clear |
| A client can end the relationship | An Identification API endpoint closes the `person_relationship` row in one transaction. | close |
| A closed relationship ends recurring obligations and starts retention | Closing NULLs both due dates so the recheck clocks stop finding the row, and stamps `retain_until` from the close. | retention clock |

Concrete technology is named once, here, so the design above stays portable:

| Concern | Choice | Why, at this scale |
| --- | --- | --- |
| System of record, queue, outbox, inbox | **PostgreSQL** | One atomicity, consistency, isolation, durability (ACID) transaction across transition + outbox + inbox; `SKIP LOCKED` makes it a competent queue at single-digit writes/s. |
| ID photos | Any object store (S3, GCS, Azure Blob) | Cheap immutable blobs; presigned upload keeps bytes off the API; the database keeps only the key. |
| Shared breaker state, fallback weights | A shared cache (Redis or equivalent) | State and weights must outlive any one replica and be read on every claim. |
| Message broker | Not yet: RabbitMQ or a managed queue at the exit | Trigger set in Right-sizing: roughly sustained 100k flows/day. |
| Workflow engine | Not yet: Temporal or a cloud step orchestrator at the exit | Buys durable timers and versioned orchestration when flow variants multiply, at the price of the append-only history. |
| IDV, sanctions, email | The given vendors | Their contracts (callback vs poll, rate limits, downtime) shape the pools; their internals are out of scope. |
| Auth | The given internal auth service (clients); magic-link sessions (onboardees) built here | The given service covers tenant API keys and dashboard single sign-on (SSO); the onboardee's session is possession of a single-use link (dive 12, Q7). |
| Observability | OpenTelemetry + a metrics store (Prometheus or equivalent) | Correlation on flow id; per-vendor metrics double as breaker and weight inputs. |

{#architecture-table-1}

## Deep dives
<!--meta block=deepdives-->

### 1 · The queue lives in the database → NFR: scale

**At ~10 writes/s peak, the queue's entire value is that a task insert shares a transaction with the state change that spawned it, so scale-out is more replicas, not more infrastructure.** Worker replicas compete for tasks with `FOR UPDATE SKIP LOCKED` ([competing consumers](../patterns/messaging/competing-consumers.md) on a Postgres queue, [load-leveling](../patterns/distributed/resilience/load-leveling.md) without a broker): the claim locks a pending row and skips anything already locked, so two workers cannot claim the same task and none ever blocks. A broker is rejected today because it breaks that atomicity and adds an operational surface, to solve a throughput problem this system does not have. Screening concurrency comes from the same mechanism: sanctions legs are ordinary task rows, so the ceiling is the per-vendor rate counter in the shared cache, never worker count.

**Sharing that queue with the recheck batch is the design's own [noisy neighbour](../hazards/noisy-neighbour.md), and an off-peak window alone does not fix it.** At steady state the batch writes about as much as live intake (Right-sizing), so a window that overruns, say a list vendor's delta stamping `recheck_due_at = now()` across the affected book, puts 40k deferrable tasks in the table the live claim query scans, and a person waiting on an invite queues behind a compliance sweep. Ordering the claim by class is the wrong reach: a [priority queue](../patterns/messaging/priority-queue.md) advises against strict preemption when the low class also has a deadline, and re-screening has one, the jurisdiction's legal cadence. So the split is **reserved capacity per class**: recheck tasks carry their own `kind` prefix and are claimed by a separately sized pool, the per-vendor bulkhead applied a second time. Live flows keep a floor the batch cannot borrow from, and the batch keeps a floor a busy onboarding day cannot starve. The per-vendor rate counter splits the same way, because two pools on one quota are not two pools: on a delta day the batch would spend the whole contracted rate and push live legs out on `run_after`, with aggregate alarms green. Per-class oldest-pending age is the alarm that sees it.

**The first real bottleneck is the task table, not the flow table, and its exits are priced in [Right-sizing](#sizing-h-limits).** Each exit lands on a live queue, so it is a migration: the partial index on `status = 'pending'` arrives with `CREATE INDEX CONCURRENTLY`, so no lock the claim query would feel, and completed tasks are pruned by batched off-peak deletes until partitioning makes the prune a partition drop. The sharding exit composes with residency for free, because `client_id` is both the key no query spans and the key that pins a client's rows to its region.

**Capacity moves on queue age, never on processor load.** These pools sit blocked on vendor calls, so utilisation stays near zero while the backlog grows, and an [autoscaler](../patterns/distributed/routing/autoscaling.md) reading CPU would watch a starving queue and never fire. Each pool scales out when its own oldest pending task passes 60 seconds and back in after ten minutes below five, with a floor of two replicas and a ceiling set by the vendor's contracted concurrency, not by our budget. Scale-in needs no special handling: a stopping replica finishes or abandons its claim, and an abandoned claim is the expired-lock case the sweeper already runs, so a deploy is the same protocol as a crash.

**A queue absorbs a burst and hides sustained overload, so the accept path is coupled to the drain rate.** Without a ceiling, `POST /flows` keeps saying 202 while the live backlog grows past any deadline the flow could meet. So when the live class's oldest pending task passes its age ceiling the create answers `429` with a `Retry-After`, which is [backpressure](../patterns/concurrency/backpressure.md) and not a rate limit: the limiter bounds one tenant against a contracted share, while this bounds everyone against what the fleet is draining. Refusing costs the client a retry it can see; accepting costs a flow that sits invisible for hours. The recheck class carries its own ceiling and never trips the live one, because a compliance sweep must not close the front door.

```sql summary="The claim query"
UPDATE task
SET    status = 'processing', locked_by = $worker,
       locked_at = now(), attempts = attempts + 1
WHERE  id = (
  SELECT id FROM task
  WHERE  status = 'pending' AND kind = ANY($kinds)
    AND  run_after <= now()          -- backoff and queue-and-wait both live here
  ORDER  BY id
  FOR UPDATE SKIP LOCKED             -- competitors skip, never block
  LIMIT 1)
RETURNING *;
```

```mermaid caption="How do replicas claim work without blocking or double-claiming? They compete for rows on one table, and adding capacity is adding a replica."
flowchart LR
    W1["Worker fleet — replica A"] -->|"claim next pending · FOR UPDATE SKIP LOCKED"| T[("Postgres — task rows")]
    W2["Worker fleet — replica B"] -->|"claim — locked rows skipped"| T
    W3["Worker fleet — replica C"] -->|"claim"| T
```

### 2 · Obligations attach to history — the machine keeps its shape → NFR: evolvability

**The flow enum holds only the five-state model's business states; every operational fact lives on task rows.** Retry counts, locks and backoff timestamps change constantly and mean nothing to a client or an auditor, and folding them into the enum turns a readable contract into a dozen-value tangle where "what happened to this person" and "what is the queue doing" cannot be told apart. The seam pays three ways: the client-visible vocabulary never changes when retry mechanics do, the transition history stays a clean append-only account of business fact, and the audit requirement is met by projection rather than a second write path that could disagree. One writer of truth (the state machine), any number of readers.

The state model is the contract everything serialises into: five business states with an explicit finished branch, and **Invalid ID exits before sanctions ever runs**, because screening an unverified identity is spend without meaning. **No finished state is permanent**: two jurisdiction-driven clocks re-enter a cleared flow, a sanctions recheck at the screening step and an expired or revoked document back at the invite, because only the person can supply a new document.

Both clocks reuse the same machinery. A scheduled job re-enters `Clear` flows at Awaiting Sanctions Check when the cadence comes due, appending a `sanctions_recheck` transition. Re-entry collides with the duplicate-invite rule: `one_open_flow` indexes only open rows, so while a flow sits at `Clear` the client may start a second flow for the same person, and moving the old one back to an open state would violate the index, roll the transition back and retry until the task dead-letters, failing a compliance obligation silently for exactly the people onboarded twice. So the clock skips a flow that a newer flow for the same `(client_id, email_mac)` has superseded: the obligation follows the person, and the newest flow's clock already carries it. A list update does not wait for the calendar: a vendor's delta stamps `recheck_due_at = now()` across the affected book, and the same sweep picks those rows up, so event and cadence funnel into one due-date column. History stays append-only: the flow moves again, its past does not change.

**That delta mechanism needs jitter, or the calendar produces a herd nothing can drain.** Stamping `now()` across 40k flows × four lists makes 160k legs due at one instant, about 22 hours of draining at ~2 calls a second, longer at a rate contracted for live volume, against a compliance clock. Reserved capacity per class (dive 1) stops the herd starving live flows but does not shrink it. So the stamp is `now()` plus a deterministic offset computed from the flow id, spreading the book across the window the cadence still allows. Computing it from the id, not randomising, means a re-run of the delta does not reshuffle the queue, and the spread is reproducible when someone asks why a flow was screened when it was.

**"Configuration, not a code change" only holds if the configuration lives somewhere a deploy is not.** The list roster per jurisdiction, each list's `criticality`, the recheck cadences, the vendor quotas and the fallback weights are what the evolvability requirement says a new jurisdiction or vendor may change alone. Held in the deployed artifact they are source, and a new jurisdiction becomes a release across every regional stack. So they sit in an [external configuration store](../patterns/distributed/coordination/external-configuration-store.md), versioned, audited and rollback-able like code, and workers refetch on a short interval, because a central store nobody refetches from is a slower file with more failure modes. Secrets stay out, the way `webhook_secret_ref` already does.

**The cold-start dependency gets a stated answer.** A worker that cannot reach the config store at boot must not fall back on compiled-in defaults: a default roster screens against the wrong lists and concludes flows that look successful and are not. So it boots from the last configuration it durably cached, refuses to start if it has none, and reports the version it runs, so a stale roster is visible. A stale configuration is recoverable and legible; an invented one is neither.

**The machine's shape also survives its own deploys.** A new task kind or flow state ships reader-first: workers that understand it deploy before the writer that emits it, and the claim's `kind = ANY($kinds)` is the guard, so a mixed-version fleet never picks up work it cannot run. The enum extends before any transition writes the new value, and old code's guarded transitions keep updating zero rows on states they never learned.

```mermaid caption="Where can the flow end, and how does it come back? Four finished states, none permanent: a recheck re-enters at screening, an expired document at the invite."
stateDiagram-v2
    [*] --> Initiated
    Initiated --> AwaitingSubmission: invite emailed
    AwaitingSubmission --> AwaitingIDV: magic link used, documents in
    AwaitingIDV --> AwaitingSanctions: ID verified
    AwaitingIDV --> InvalidID: verification failed
    AwaitingSanctions --> Clear: every list answered, no hit
    AwaitingSanctions --> Sanctioned: any list reports a hit
    AwaitingSanctions --> CaveatedClear: an advisory list is unavailable
    Clear --> AwaitingSanctions: sanctions recheck due
    Clear --> AwaitingSubmission: ID expired or revoked, re-invite
    CaveatedClear --> AwaitingSanctions: missing list returns
    Clear --> [*]
    CaveatedClear --> [*]
    Sanctioned --> [*]
    InvalidID --> [*]
    AwaitingSubmission: Awaiting Submission
    AwaitingIDV: Awaiting ID Verification
    AwaitingSanctions: Awaiting Sanctions Check
    InvalidID: Invalid ID
    CaveatedClear: Cleared with Caveat
```

### 3 · One transaction, every consequence → NFR: consistency

**Every transition commits with its consequences, or not at all.** "Record the state change" and "tell the client" are two systems with no transaction spanning them, so write-then-crash-before-publish leaves the database saying `clear` while the client hears nothing, forever. The [outbox](../patterns/distributed/coordination/outbox.md) closes the gap by making "publish" a second local write: transition, outbox event and follow-up tasks in one Postgres transaction. The dispatcher retries delivery against a durable row, and `published_at IS NULL` is always the honest list of what is still owed.

**Order is a separate guarantee from dedup, and conflating them is how a client ends up acting on the wrong verdict.** A re-screen flips a flow from `clear` to `sanctioned`; that delivery takes a 502 and enters backoff; a later re-verification event delivers first, and the client's last-write-wins handler now believes a person is cleared who is not. The events carry distinct `eventId`s, so dedup absorbs neither, and N dispatchers draining a shared queue have no opinion on order. So the dispatcher claims a **flow**: `delivery_cursor` holds one row per flow, and the worker sends the lowest unpublished outbox `seq` above `delivered_seq`, advancing only on a 2xx. That is a [sequential convoy](../patterns/messaging/sequential-convoy.md): parallel across flows, single-file within one, so one client's stuck endpoint holds up its own results and nothing else. The payload also carries `seq`, so a client can discard anything older than what it has applied even if the network reorders. The price is that a flow in backoff blocks its own later events, which is what you want when the later event corrects the one that has not landed.

**The receive side is the trap most designs miss.** Vendors deliver callbacks at-least-once, and a duplicate can arrive before this system has written anything, so a key we generate at publish time has nothing to collide with. The [inbox](../patterns/distributed/coordination/inbox.md) keys on the sender's id, `(flow_id, step, provider_request_id)`, and its insert shares a transaction with the callback's effect. Whichever copy commits first wins, the second hits the unique constraint and rolls back whole, and arrival order stops mattering.

**Every vendor's model is translated at the edge, before anything downstream sees it.** Seven foreign models reach this system (two ID providers, four list vendors, the email sender), each with its own word for a match and its own confidence scale. Unnormalised, the adjudication rule is written in seven dialects and one vendor's contract change edits our business logic. So each provider gets an [anti-corruption layer](../patterns/ddd/acl.md): a translator that parses the payload, maps it onto our three-valued outcome and hands the state machine a shape it knows. It stays a translator, never an adjudicator: what a hit means to a flow is the state machine's decision. The translator also stamps `provider` and `policy_version` onto the transition it produces, which is what lets the history answer how a person was verified once traffic can shift to a fallback mid-incident and policies can change.

**Parsing happens before the transaction opens, and that ordering is load-bearing.** If the parse sits inside the effect transaction and a vendor ships a contract change the parser rejects, the rollback takes the inbox row with it: no record of the callback exists, the vendor retries for ever, and dead-lettering, a write in the aborted transaction, is impossible. With the parse ahead of `BEGIN`, one transaction commits the inbox row, a dead-letter row and an escalation together and then ACKs, so the vendor stops retrying and an operator gets the payload that broke us.

**Outbound calls carry our idempotency key for the same reason in reverse.** The invite email and the webhook go to systems that might read our retry as a new request, so each send carries a key built from the durable row's id: the task for the email, the event for the webhook (`eventId`). A key generated at send time differs on every attempt and collapses nothing (dive 12, Q8). **The transition itself is the second guard**: every state change carries `WHERE state = expected AND version = seen`, so a zombie worker whose lock the sweeper already expired writes zero rows, and the worst case left is a repeated vendor call that the outbound key collapses.

```sql summary="One transaction, five facts — the whole core in SQL"
-- The IDV callback arrives: verify_id passed for flow F.

-- 0 · OUTSIDE the transaction: the provider's ACL parses and normalises. A parse failure
--     commits inbox row + dead-letter row + escalation together and ACKs the callback.
--     → ($outcome, $provider, $policy_version) in OUR vocabulary.

BEGIN;

-- 1 · dedup at the boundary, keyed on the VENDOR's request id. A duplicate violates the
--     unique constraint, aborts this txn and is ACKed with no effect.
INSERT INTO inbox (flow_id, step, provider_request_id)
VALUES ($flow, 'verify_id', $provider_request_id);

-- 2 · the business transition, guarded twice: expected state + version.
UPDATE flow
SET    state = 'awaiting_sanctions_check', version = version + 1
WHERE  id = $flow
  AND  state = 'awaiting_id_verification'   -- legal-transition guard
  AND  version = $seen_version;             -- optimistic check against zombies
-- 0 rows updated → someone got here first → ROLLBACK, ack, done.

-- 3 · append-only history, carrying WHO answered and to WHAT standard
INSERT INTO flow_transition (flow_id, seq, from_state, to_state, cause,
                             provider, policy_version)
VALUES ($flow, $next_seq, 'awaiting_id_verification',
        'awaiting_sanctions_check', 'idv_passed',
        $provider, $policy_version);

-- 4 · consequences: an event the client will hear, and the fan-out tasks
INSERT INTO outbox (flow_id, event_id, payload)
VALUES ($flow, $event_id, $payload);

INSERT INTO task (flow_id, kind)
SELECT $flow, 'check_list:' || l FROM unnest($sanction_lists) AS l;

COMMIT;   -- all five facts, or none of them
```

**The only fan-out in the flow concludes exactly once, and its legs run in parallel.** Sanctions is gated on a verified identity: screening unverified data is vendor spend that produces noise, so running it beside ID verification is deliberately rejected (dive 12, Q3). The concurrency lives inside the step. The concluding transaction inserts one `check_list` task per list ([Scatter-Gather](../patterns/messaging/scatter-gather.md)), sanctions-pool replicas claim the legs independently, and each leg owns its deadline, retry budget and result row, so a slow list never delays a fast one. The join is where the guarded transition is not enough. Each completing leg records its outcome, counts final outcomes against the list count and transitions when the count is full. Under the default `READ COMMITTED`, two legs finishing at the same instant each see their own uncommitted insert and not the other's, so both count one short and **neither** transitions: the flow hangs with every leg reported. The guarded update stops two conclusions, not zero, and the version check is the wrong instrument because the bug is a phantom read, not a lost update. So the completing transaction takes `SELECT … FROM flow WHERE id = $flow FOR UPDATE` before it counts: the second leg blocks, re-reads, sees the first's result, counts full and concludes. One row lock, held for the length of a count, on a step that runs once per flow.

**And it counts within its round.** Each fan-out issues a fresh `round` that its legs carry, because a re-screen would otherwise reuse the first screen's rows: the first leg back would count every list as reported against last quarter's verdicts, conclude early on stale answers, and then swallow a real hit arriving late, whose guarded transition finds the flow already finished. That is the one failure this design must never have, so `round` is in the primary key. The verdict is `Sanctioned` on any hit and `Clear` only when every list answered and none hit. "Hit" is the vendor's adjudicated verdict (the out-of-scope entry on match review), and a re-screen fans out the same way, keyed to its `sanctions_recheck` transition.

**A leg that can never answer must still be able to end, because "all legs in" is policy, not a consistency requirement.** A two-valued verdict leaves an unanswered leg no way to finish, so a vendor's permanent failure, a list withdrawn or a contract lapsed, becomes our permanent outage. So the leg outcome is three-valued, `hit`, `clear` or `unavailable`, and "all legs in" means every leg holds a final outcome. The sweeper stamps `unavailable` when a leg's task exhausts its retries, turning a hang into a decision (con 5). The decision is configuration: each list carries a `criticality` of `blocking` or `advisory` per jurisdiction. **Blocking and unavailable holds the flow and escalates**, since on the list a regulator asks about, late beats wrong. **Advisory and unavailable concludes `cleared_with_caveat`**, records the missed list and schedules a re-screen for when it returns. Reading an unanswered check as clean is the one reading [scatter-gather](../patterns/messaging/scatter-gather.md) rules out by name, so the gap rides on the verdict where the client must read it.

**Answering without a list does not abandon the consistency and partition tolerance (CP) stance.** A partition to one vendor is a **missing input**, not a conflicting write: no second writer of this flow's state exists, so answering availability-style risks none of the divergence the C choice prevents. What became configurable is which inputs a conclusion requires, and the caveated verdict names the ones it did without.

**A leg that reports after the flow concluded is the one report this system must never drop.** Leg C dead-letters, the flow concludes without it, and three hours later C's callback carries a `hit`. The inbox insert succeeds, since the `provider_request_id` is new, but the guarded transition finds `state ≠ awaiting_sanctions_check`, updates zero rows and ACKs with no effect: the guard that prevents a double-apply is a silent drop. So the leg's outcome is written **unconditionally**, in its own statement, decoupled from the transition. A late `hit` then stamps `recheck_due_at = now()`, the re-screening sweep re-enters the flow at Awaiting Sanctions Check, and the corrected verdict leaves through the same webhook as the first, as the requirements promise.

```mermaid caption="How do several lists become one answer? One task per list, one guarded transition when every leg has finished; a late leg is recorded and re-enters as a re-screen."
flowchart LR
    F["Flow at Awaiting Sanctions Check"] ==>|"one task per list"| LA["Leg — list A"]
    F ==>|"one task per list"| LB["Leg — list B"]
    F ==>|"one task per list"| LC["Leg — list C"]
    LA -->|"outcome: hit / clear / unavailable"| COL["Collector"]
    LB -->|"outcome"| COL
    LC -->|"outcome"| COL
    COL -->|"every leg finished → ONE guarded transition"| T["Clear / Cleared with Caveat / Sanctioned"]
    LC -.->|"late outcome, recorded unconditionally"| R["Re-screen: recheck_due_at = now()"]
    R -.->|"corrected verdict, same webhook"| COL
```

**CAP, applied rather than recited: choose C and refuse writes rather than risk divergence.** Accepting a create on a secondary while the primary is unreachable or failing over is [split-brain](../hazards/split-brain.md): two "open flows" for one (client, email), or a transition without its outbox guarantee, and the partial unique index cannot help because each half enforces uniqueness only against rows it sees. So the single-writer Postgres refuses, creates return errors, and in-flight work stalls in the queue and drains afterwards, as after vendor downtime. PACELC: PC/EC, paying latency in every branch and never inconsistency. The internal truth is CP; the client-facing view is the one EC surface, because an at-least-once webhook lagging by minutes was accepted up front.

### 4 · Surviving the vendors — and every other stall → NFR: availability & resilience

**Vendor failure degrades latency, never correctness.** The ID vendor's ~6 hours a week of downtime is absorbed by the queue: the [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md) opens, tasks get a pushed-out `run_after` ([retry with backoff](../patterns/distributed/resilience/retry-backoff.md) recorded on the task row), and the flow waits. One [worker pool](../patterns/concurrency/thread-pool.md) per vendor (a [bulkhead](../patterns/distributed/resilience/bulkhead.md)) means a stalled sanctions vendor cannot starve ID verification, and every task carries its own [deadline](../patterns/distributed/resilience/timeout-deadline.md) because no vendor publishes one. Three mechanisms make the rest graceful:

- **Shared breaker state.** The breaker for each vendor lives in the shared cache, not in each process: per-replica breakers each need their own failure streak, so N replicas take N× the damage and send N half-open probes, where one shared record means one probe decides recovery (dive 12, Q5). **That buys a dependency, so its failure gets an answer.** Failing open on a delta day would send 160k recheck legs at vendors with no rate ceiling and no breaker, a storm aimed at a contractual quota. So workers **fail closed onto a local fallback**: each replica keeps a conservative in-process breaker and a local token bucket sized at its fair share of the quota, so a cache outage costs latency, not a quota breach. **The fair share is a static 1/N, a priced cost:** idle replicas hold their slice, so the achieved rate sags below the contracted one during a drain. The deferred exit is replicas that **lease blocks of quota** from the shared counter while it is healthy and spend the unexpired lease while it is not; 1/N is honest at four replicas. **A cache that comes back empty does not say everything is healthy.** After a restart the breaker records are gone, and reading absence as closed sends the fleet at a vendor that may still be down. So a missing record seeds the breaker **open**, and the single half-open probe re-admits the vendor, at the cost of one probe interval after every cache restart.
- **Fallback providers with governed weights.** Where a second provider exists, workers split traffic by weights held in the same cache, driven by the recorded per-provider error rate and latency, decaying back toward the default as health recovers, with a manual override that outranks the automation during incidents or contract changes (dive 12, Q6). A weighted split with no update mechanism is a constant nobody dares touch.
- **Email is a vendor too.** Sends carry an idempotency key (dive 3); bounces come back as inbox events and mark the invitation dead, which the sweeper escalates like any stuck flow.

**Retry is bounded work, and the bound is two columns.** `attempts` counts, `max_attempts` stops, `last_error` is what an operator opens the dead row to read. Without the budget a malformed vendor response burns a worker slot for ever; without the error the dead task has no diagnosis. **The schedule carries jitter.** A six-hour outage fails every waiting task at about the same instant, so pure exponential backoff returns them all at the same instant and the recovering vendor meets the whole backlog at once, which reads as a flapping vendor and is a synchronised herd. The delay is randomised within its window, the same spreading the recheck delta does deterministically (dive 2).

**The quota ceiling is priced per second and per month, and backoff clears only one.** The token bucket turns a burst into a wait that ends. A contracted monthly cap breaks that: legs three and four of a fan-out reach it on the 28th and cannot succeed until the reset, so retrying on a growing backoff spends the month rediscovering the same answer. Quota exhaustion is its own class, **non-retryable-today**: `run_after` is deferred to the reset date and the escalation fires **once at class level**, because on a delta day the per-leg alternative raises 40k alarms and buries the one that matters.

**A vendor that takes the work and never calls back is invisible to every mechanism above.** The send task completed, so nothing looks stuck: no expired lock, no exhausted retries. Only the flow-level SLA (service-level agreement) notices, hours later. So the send writes its own deadline: an `await_callback:<vendor>` task, inserted in the send's transaction, with `run_after` at the answer time the vendor's contract promises. The callback's transaction completes that task, so a normal vendor leaves no trace. A silent one leaves it to come due, and the claiming worker finds the leg with no final outcome and treats it as the vendor failure it is. Silence becomes a task expiry in minutes instead of an SLA breach in hours, at one row per outbound call.

**Those deadlines are per vendor, and the flow's own SLA is worked out from them.** One jurisdiction's roster can hold a list that answers in 200 ms beside one that returns a batch file the next day, so a single flow deadline is too tight for one and useless for the other. Awaiting Sanctions Check counts as overdue only when its **slowest configured list** is, a figure read from the roster in the config store: four synchronous lists escalate in minutes, and a 24-hour batch list pages nobody at hour two.

**Every flow state has an SLA, and the sweeper enforces it.** One scheduled job sweeps three conditions: expired locks (reset to pending for a competitor), exhausted tasks (marked `dead`, a [dead-letter channel](../patterns/messaging/dead-letter-channel.md) as a table, and for a sanctions leg stamped `unavailable`) and overdue flows (escalated). Escalation goes three ways: an operator alert, a dashboard surface, and **a failure event through the same outbox path for the client**, because silence toward the paying client is the one failure mode this design refuses. Escalation is also a **transition**: the overdue flow moves to `expired`. Left open, it leaks three ways: the sweeper re-sends the same alert every pass, the row stays inside `one_open_flow` so the repeated create returns the dead flow for ever, and the parked-flow count becomes a floor that climbs with every abandonment. A dead task is parked, inspectable and re-runnable after the cause is fixed, never silently dropped.

**The sweeper and both recheck clocks are singletons, and a replica set does not make them so.** Two sweepers escalate the same overdue flow twice (two failure events, two pages), and two recheck clocks buy the vendor call twice. So each scheduler takes a [lease](../patterns/distributed/coordination/leader-election.md) in the shared cache, a keyed record with a short expiry, renewed while the holder works. A replica that cannot renew stops sweeping before the lease expires under it, so the takeover is a gap in coverage and not an overlap in firing. A scheduler dying mid-pass costs one lease interval, which the deadlines have room for, and every sweep action is idempotent anyway.

**Those escalation clocks are numbers set below the objectives they protect.** Four indicators are measured, each a column or a count: a flow's age in its current state, a task's age since it became claimable, delivery attempts outstanding per flow, and per-vendor error rate. Against the internal objectives in the requirements, the client is promised something looser, a page within 15 minutes and a failure event within 5 minutes more, and the gap is the error budget: spend it on deploys, vendor outages and the occasional bad batch, and when it is gone stop shipping rather than restate the number. The sweeper running every 60 seconds against due-date predicates is what makes the 15-minute page achievable.

**The database gets the same treatment as the vendors: its failure is planned.** An asynchronous replica looks cheaper and is rejected because it can acknowledge a commit the standby never received, and the fact lost would be the outbox row this design exists to never lose. The choice is a synchronous in-region standby ([replication](../patterns/distributed/coordination/replication.md), single-leader and synchronous): failover is a promotion rather than a restore, and the queue-in-DB property makes the switch lossless, work draining on return as after vendor downtime. The cost is every commit paying the standby's round-trip and a doubled database bill, trivial at ~10 writes/s.

**Losing both nodes is a restore, and the restore has numbers.** Continuous archiving gives point-in-time recovery; primary and standby gone together, a region-scale event (con 4), means restoring to the last archived segment, with the RPO (recovery point objective) stated in the runbook and the RTO (recovery time objective) measured by a rehearsed drill. What the restore rolled away, the edges catch: a callback for a flowId the restore forgot is acknowledged and parked for the operator, a replay answers `404`, and a re-submitted create walks in clean because `one_open_flow` restored with everything else. At ~10 writes/s, minutes of archive lag is a handful of re-runnable flows, a window the design names instead of implying zero.

```mermaid caption="How does the Worker fleet keep one stalled vendor from starving the rest? One pool per vendor, one shared breaker record per vendor, and a sweeper that turns every stuck thing into a retry, a dead-letter row or an escalation."
flowchart TB
    subgraph WK["Worker fleet"]
        IDVP["IDV pool · bulkhead"]
        SANP["Sanctions pool · bulkhead"]
        EMLP["Email pool · bulkhead"]
        SW["Sweeper"]
    end
    IDVP -->|"call if circuit closed"| V["IDV · Sanction lists · Email"]:::ext
    SANP -->|"call"| V
    EMLP -->|"send invite"| V
    IDVP -.->|"read breaker + weights"| CACHE[("Shared cache · circuit-breaker")]
    SW -->|"re-queue expired locks · dead-letter exhausted · escalate overdue"| PG[("Postgres")]
    classDef ext stroke-dasharray:4 4;
```

### 5 · One id, few signals, honest alerts → NFR: observability

**At this scale, observability is one correlation id, a handful of alerts, and SQL.** The flow id threads every transition, task, vendor call and delivery attempt, so "why is flow X stuck" is one query over tables that already exist, with no distributed-trace archaeology at ~75 flows a day. The alerts watch leading indicators, chosen so a vendor's bad day is never misread as this system's outage: flows overdue per state (the SLA breach, and the sweeper's own health), task queue depth and oldest-pending age, dead tasks (anything above 0 is a page), per-vendor error rate and latency (tracked per vendor, doubling as the breaker and weight inputs), and webhook delivery failure rate (our SLO (service-level objective), not the vendors'). Logs carry ids only ([secure logger](../patterns/security/secure-logger.md)); the vault is the one place raw PII exists, so the log pipeline never becomes an unencrypted second copy.

```mermaid caption="Which signals does an operator act on? Every alert is a leading indicator, and the per-vendor series double as the breaker and weight inputs."
flowchart LR
    PG[("Postgres — every row carries the flow id")] -->|"one query: why is flow X stuck"| OP["Operator — alert + runbook"]
    WK["Worker fleet"] -->|"per-vendor error rate, latency"| M[("Metrics store")]
    M -->|"stuck flows · queue depth · dead tasks · delivery failures"| OP
    M -->|"drive breaker state + fallback weights"| CACHE[("Shared cache")]
```

### 6 · Evidence, erasure, retention → NFR: compliance

**Erasure is key destruction, evidence outlives the person, and retention runs on the relationship's clock.** Business tables carry `person_ref`; the vault holds the encrypted payload, one envelope key per person. Those are two stores and two writes with no transaction between them, a [dual write](../hazards/dual-write-inconsistency.md), so the rule is **vault first, reference second**: the payload is written and its id returned before any business row names it, so the only crash residue is an unreferenced vault blob, swept on the retention clock, never a `person_ref` pointing at nothing, which would be a flow whose erasure cannot be proved. Erasure (`DELETE /persons/{id}`) destroys the key and purges the photo, **crypto-shredding** every copy, backups included. What survives is deliberate: the flow's decision and transition history, because "a lawful check ran and concluded" is a compliance record that outlives the data it was computed from.

**The one identifier outside the vault has to be keyed, or the erasure is a claim and not a fact.** The flow row carries a digest of the email so the duplicate-invite index works without reading the vault, and a plain hash of an email protects nobody: addresses are enumerable, so anyone with a dump and a list recovers which named people were screened, by which client, to what verdict. So the column is `email_mac`, an HMAC under a per-region key the key manager holds, and erasure destroys that key alongside the person's envelope key. The cost is that the key is load-bearing for uniqueness: rotating it means recomputing every live flow's MAC, a maintenance job the design owns.

ID photos go straight to [object storage](../patterns/distributed/routing/object-storage.md) by [presigned upload](../patterns/distributed/routing/valet-key.md), a short-lived valet key issued at submit, and workers pass the storage key, never bytes ([claim check](../patterns/messaging/claim-check.md)). Retention is per jurisdiction, and the obvious mechanism is wrong: an object-store lifecycle rule expires by object age, while the requirement counts from the **end of the relationship**, an event years later in another system that the bucket cannot see. So photos are retired the way `magic_link_key` rows are, by a scheduled retention sweep reading `person_relationship.retain_until`, which the close endpoint stamps from `closed_at`; the lifecycle rule stays as a backstop for orphaned objects. Without a way for a client to say the relationship ended, retention has no start date and recurring screening no end, so the system keeps buying quarterly checks on people it has no lawful basis to process. Closing NULLs both due dates in the same transaction, the entire termination rule.

Erasure is gated. `DELETE /persons/{id}` destroys a key that also reaches backups, so a request arriving while the merchant is under statutory record-keeping would destroy evidence the client must hold. The request is checked against active holds first: no hold, erase now; hold present, record the request, refuse the destruction and honour it when the hold lifts. The design picks a side in the mechanism, between the right to erasure and the duty to retain. **The access papertrail:** every vault read appends who, what, when to the audit table; flow history answers "what happened to this person", the papertrail answers "who looked".

```mermaid caption="Where can personal data live, and how does it die? Business rows hold only person_ref, every vault read is recorded, and erasure is key destruction that reaches backups too."
flowchart TB
    subgraph PG["Postgres — flow, transition, task, outbox, inbox"]
        OPS[("Operational rows — person_ref only")]
        AUD[("Access papertrail")]
    end
    VLT[("PII vault — per-person envelope keys, own credentials")]
    API["Identification API"] -->|"business writes"| OPS
    API -->|"PII read / write · erase = destroy key"| VLT
    VLT -->|"every read appended"| AUD
    U["Onboardee"] -->|"presigned PUT — ID photo"| BL[("Object store · claim-check")]
```

### 7 · The database enforces tenancy; the network limits reach → NFR: security & tenancy

**Isolation is enforced where queries run, not where developers remember.** Application-level RBAC (role-based access control) filters are one forgotten `WHERE client_id =` from a cross-tenant leak; row-level security makes the database refuse the un-scoped read from any code path. Three details decide whether the policy holds. `ENABLE ROW LEVEL SECURITY` alone is bypassed by the table's owner, so the application connects as a **non-owner** role and every client-scoped table also carries `FORCE ROW LEVEL SECURITY`; without it the policy binds everyone except the migration role, often the role the application inherited. The tenant is set with `SET LOCAL`, so the setting dies with the transaction instead of riding a pooled connection into the next tenant's checkout, a leak invisible in any test with one connection per test. And the worker fleet claims across all tenants, so it cannot run under the policy: it runs as a separate, separately audited principal with its own credentials and no dashboard path, an exemption named here and not found during an incident. Three more layers complete the posture:

- **No flat network.** Only the API tier is publicly reachable; workers, Postgres, the cache and the object store sit in a private segment, so an attacker at the public tier reaches a service that holds tokens and references, not data.
- **Authenticated edges.** Webhooks are HMAC-signed with a stable `eventId`; the onboardee's magic link is single-use, expiring, stored only as a hash and scoped to one flow's submission surface, never to anything client-scoped (dive 12, Q7). Redemption is a conditional `UPDATE` read by rowcount, so two concurrent redemptions cannot both win and zero rows tells expired from forged from spent. The link is spent when the **document** lands, not when the form posts, so a flaky upload does not become a support case. A rotation dual-signs during the overlap because the signature header names its key id.
- **Egress is guarded like ingress.** A `webhookUrl` is client input pointed at our dispatcher: it is accepted over HTTPS only, resolved and refused against private, link-local and metadata ranges at registration and again at delivery, so a DNS flip buys nothing, and delivered from a dedicated egress with no route into the private segment. Ownership is proven before the first verdict by a challenge that must round-trip, so a tenant cannot point KYC (know your customer) verdicts about a named person at a server it does not control.

```mermaid caption="What can be reached from where? The API is the only public surface, RLS refuses the un-scoped query from any code path, and everything stateful sits off the public internet."
flowchart TB
    C["Client"] -->|"TLS — API key / SSO"| API["Identification API"]
    U["Onboardee"] -->|"single-use magic link"| API
    subgraph PRIV["Private network — no public route"]
        PG[("Postgres — RLS per tenant")]
        CACHE[("Shared cache")]
        WK["Worker fleet"]
    end
    API ==>|"RLS session per tenant"| PG
    WK -->|"claim · sweep"| PG
    WK -->|"outbound only — HMAC-signed"| CB["Client endpoint"]:::ext
    classDef ext stroke-dasharray:4 4;
```

**Regions are islands: a [deployment stamp](../patterns/distributed/routing/deployment-stamp.md) per region, not a tenant column.** Residency is one full stack per region (gateway, API, workers, Postgres and its standby, vault, object store, cache). A client is pinned to a region at onboarding, DNS routes it there, and every identifier below the gateway is region-local. Nothing crosses: no cross-region replication of personal data or documents, which is the requirement itself, and cross-region failover is out of scope, so a regional outage is downtime for that region's clients alone. The price is N copies of everything, kept in check by stamping every region from the same infrastructure-as-code so only configuration varies (con 4).

```mermaid caption="Where does a client's data live? In its region's stack and nowhere else: the same code stamped per region, with no replication or failover across the boundary."
flowchart LR
    CEU["EU client + onboardees"] -->|"DNS — region recorded at onboarding"| REU
    CUS["US client + onboardees"] -->|"DNS"| RUS
    subgraph REU["Region EU — full stack"]
        SEU["Gateway · API · workers · Postgres + standby · vault · object store"]
    end
    subgraph RUS["Region US — full stack"]
        SUS["Gateway · API · workers · Postgres + standby · vault · object store"]
    end
    REU -.-|"nothing crosses — no data path"| RUS
```

### 8 · A clean check, end to end

The dives above argue one requirement at a time; the four scenarios below run the mechanisms together, so you can read the order in which the guards fire.

**A successful check is a chain of small transactions: every state switch is one commit, and everything between commits is a row waiting.** This is the happy path of the lifecycle in dive 2, played out in time: the client hears each change through the outbox, the vendor's answer lands through the inbox, and no step holds a connection open while a human or a vendor takes their time. The transaction mechanics are argued in dive 3.

```mermaid caption="What does one successful check look like in time — and where exactly does each state switch commit?"
sequenceDiagram
    autonumber
    actor O as Onboardee
    participant C as Client · ext
    participant API as Identification API
    participant PG as Postgres
    participant W as Workers
    participant V as Vendors · IDV + lists + email · ext
    participant D as Webhook dispatcher
    C->>API: POST /flows · an email address
    API->>PG: one txn — flow row + invite task + outbox event
    Note over PG: state · initiated
    W->>V: send invite email · key from the task row
    W->>PG: transition on send
    Note over PG: state → awaiting_submission
    V-->>O: invite with single-use magic link
    O->>API: open link, submit ID document + selfie
    API->>PG: one txn — documents stored + transition + verify_id task
    Note over PG: state → awaiting_id_verification
    W->>V: verify_id · idempotency key from the task row
    V-->>API: callback — verification passed
    API->>PG: one txn — inbox row + transition + one check_list task per list
    Note over PG: state → awaiting_sanctions_check
    W->>V: screen each list · one leg per list
    V-->>W: no hit, per list
    W->>PG: last leg in — guarded transition + outbox event, one txn
    Note over PG: state → clear
    D->>PG: poll outbox · published_at IS NULL
    D->>C: HMAC-signed webhook · stable eventId
    C-->>D: 200 — event marked published
```

### 9 · The vendor dies mid-check — fallback to a second provider

**A dead provider costs latency, never a fact.** The failed call is recorded on the task row and retried on its own clock, and the flow's business state does not move while the stall lasts. The breaker record and the provider weights live in the shared cache (dive 4), so the decision to call the fallback is made by data every worker reads, not by a code change or a human at 3am.

```mermaid caption="How does a check finish when its provider dies — and who decides to call the fallback?"
sequenceDiagram
    autonumber
    participant W as IDV worker pool
    participant K as Shared cache · breaker + weights
    participant A as Provider A · ext
    participant B as Provider B · ext
    participant PG as Postgres
    W->>PG: claim verify_id task · SKIP LOCKED
    W->>K: read breaker + weights for the step
    W->>A: verify_id · deadline attached
    A--xW: timeout — no answer inside the deadline
    W->>PG: record the attempt, push run_after · backoff on the row
    Note over PG: flow state unchanged — the wait is a row
    W->>K: report failure · the streak opens A's breaker
    Note over K: breaker A open · weights shift toward B
    W->>PG: reclaim the task once run_after passes
    W->>K: read breaker + weights again
    alt breaker for A open — weights favour B
        W->>B: verify_id · same idempotency key
        B-->>W: verified — match
    else A recovered — weights decayed back
        W->>A: verify_id · same idempotency key
        A-->>W: verified — match
    end
    W->>PG: one txn — inbox row + transition
    Note over PG: state → awaiting_sanctions_check
```

### 10 · The quota runs out — rate limit, then circuit breaker

**The rate limiter stops calls that would succeed; the breaker stops calls that would fail.** The first is a contract ceiling (vendor quota is finite, see Right-sizing), the second a health verdict, and both land the task on the same `run_after` column, so queue-and-wait is the one response to either. A monthly cap is a third stop that no rate clears: it defers `run_after` to the reset and escalates once for the class (dive 4).

```mermaid caption="When the vendor's quota is gone and then the vendor itself fails — which mechanism stops the calls, and what un-stops them?"
sequenceDiagram
    autonumber
    participant W as Sanctions worker pool
    participant K as Shared cache · rate counter + breaker
    participant V as List provider · ext
    participant PG as Postgres
    participant S as Sweeper
    W->>PG: claim check_list task · SKIP LOCKED
    W->>K: check the vendor's rate counter
    alt quota exhausted — the contract ceiling
        K-->>W: over the ceiling
        W->>PG: push run_after — queue-and-wait, no call made
        Note over K: the limiter refuses calls that would succeed
    else quota available
        W->>V: screen list · deadline attached
        V--xW: 5xx / timeout
        W->>PG: record the attempt, push run_after · backoff
        W->>K: report failure · the streak opens the breaker
        Note over K: the breaker refuses calls that would fail
    end
    W->>K: later — one worker finds the breaker half-open
    W->>V: single probe call
    V-->>W: healthy answer
    W->>K: close the breaker · workers resume claiming
    W->>PG: backlog drains inside the rate ceiling
    S->>PG: any flow past its state SLA — escalate · alert + dashboard + failure event to the client
```

### 11 · Recheck day — the batch, and the debt it creates and repays

**The re-screening load grows with the book, not with intake, and it runs as debt: rows owed, worked off, and repaid through the same paths a live check uses.** The clock re-enters each due flow with a `sanctions_recheck` transition and tasks scheduled off the live peak (dive 1), the inbox absorbs the vendors' duplicate deliveries (dive 3), and every changed verdict leaves through the outbox like a first verdict. Three queues carry the debt: pending tasks, inbox rows and unpublished outbox events, all visibly empty when the batch is done.

**A recheck leg is not one vendor call per person, and that keeps the batch inside its window.** One call per person is the ~160k outbound calls a day Right-sizing prices, about two a second, against a rate contracted for today's live volume, so the batch would overrun its window or spend the whole quota and starve the live class (dive 1). Where a list vendor's API takes a set, the leg [batches](../patterns/concurrency/batching.md) roughly 500 persons per call, turning 160k calls into a few hundred. That buys rate and not invoice: the vendor still adjudicates and bills 160k person-list checks, so the procurement ceiling in Right-sizing stands. The cost of batching is partial failure, paid where it belongs: the response is applied **one member per transaction**, so a member the vendor could not adjudicate dead-letters its own leg while the other 499 commit. The batch is a transport optimisation, never a unit of failure; rolling back 500 results for one malformed record would turn a vendor's bad row into our re-screening outage. Live flows are never batched, because a person waiting on an invite is not waiting on 499 strangers.

```mermaid caption="Where does the recheck batch's backlog live while it works — and how is every owed result eventually paid?"
sequenceDiagram
    autonumber
    participant SCH as Recheck clock
    participant PG as Postgres
    participant W as Sanctions workers
    participant V as List vendors · ext
    participant D as Webhook dispatcher
    participant C as Client · ext
    SCH->>PG: find clear flows whose jurisdiction cadence is due
    loop each due flow — one txn
        SCH->>PG: sanctions_recheck transition + one check_list task per list · run_after off-peak
    end
    Note over PG: state clear → awaiting_sanctions_check · task debt accrues as pending rows
    W->>PG: claim legs as run_after passes · SKIP LOCKED
    W->>V: screen lists — inside the per-vendor rate ceiling
    V-->>W: results · duplicate deliveries possible
    W->>PG: one txn — inbox row + result row · dedup on the vendor's request id
    Note over PG: the inbox absorbs every duplicate
    W->>PG: last leg per flow — guarded transition + outbox event
    Note over PG: state → clear or sanctioned · outbox debt = published_at IS NULL
    D->>PG: poll the unpublished events
    D->>C: HMAC-signed webhook · stable eventId — a changed verdict delivered like the first
    C-->>D: 200 — event marked published
    Note over PG: debt repaid — the book is screened, all three queues empty
```

### 12 · Follow-up questions this design must answer

Nine questions that probe where designs like this usually break. Verdict first; the expansion unfolds.

**Q1 — A vendor retries its callback and the duplicate arrives before you have written anything. Does your idempotency hold?**\
Yes, because the dedup key is the vendor's, not ours.

> **Why publisher-generated keys fail this exact case**
>
> A key issued at publish time can only collide with events that already exist, so a duplicate racing ahead of the first write finds nothing and both copies apply. The inbox keys on the sender's id and inserts in the same transaction as the effect, so whichever copy commits first wins whatever the arrival order (dive 3).

**Q2 — Two workers pick up the same task. Prevented, or tolerated?**\
Both, deliberately: prevented at claim by `SKIP LOCKED`, tolerated at commit by the guarded transition.

> **Why one guard is not enough**
>
> The claim lock stops the common race. The zombie case slips past it: a worker stalls, its lock expires, the sweeper re-queues, a second worker finishes, then the zombie wakes and writes. The transition's `WHERE state = expected AND version = seen` makes that late write update zero rows, and the residual repeated vendor call is collapsed by the outbound idempotency key (dive 3).

**Q3 — ID verification fails. Do you still run sanctions, and is Sanctioned distinct from Invalid ID?**\
No sanctions on a failed ID, and yes, distinct finished states, because the client acts differently on each.

> **Finished-state semantics**
>
> Screening data that failed verification spends vendor quota to produce a result nobody can act on, so Invalid ID branches out of Awaiting ID Verification and the sanctions step never starts. Invalid ID means fix the submission, possibly re-invite; Sanctioned means a compliance decision. A generic "failed" throws away the bit the client pays for.

**Q4 — The magic link expired and the person clicks it. What do they see?**\
A self-serve resend that issues a fresh single-use key with a new 48-hour expiry, never a support address.

> **The resend path**
>
> The `410` from the token check routes to a resend page backed by `POST /flows/{id}/invite/resend`: prior keys are invalidated, a fresh key is issued, the email goes out again, rate-limited per flow. "Contact support" turns an expired timestamp into a ticket queue and a lost onboarding; a resend turns it into one more click.
>
> That answer exists only because the link is a durable row. A key in the shared cache under a 48-hour TTL fails three ways: an evicted key cannot be told from a forged one, so the `410` degrades into a `404`; the sweeper that re-invites or escalates the abandoned flow needs the row to act on; and `used_at` must be stamped in the same transaction as the submission, which a cache cannot join. **Expiry is a predicate; reclamation is retention.**

**Q5 — Several worker replicas: where does circuit-breaker state live?**\
In the shared cache, one breaker per vendor and not one per process.

> **Why in-process breakers underreact, then overreact**
>
> Each replica counts its own failures, so N replicas absorb N× the failures before the last breaker opens and then send N probes at a recovering vendor. One shared record means the first replica to hit the threshold opens the circuit for everyone and one probe decides recovery (dive 4).

**Q6 — You weight traffic across fallback providers. What updates the weights?**\
Recorded health metrics move them automatically; a manual override outranks the automation.

> **The weight mechanism**
>
> A small control job folds the per-provider error rate and latency already collected for alerting into weights in the shared cache, degrading a provider's share as errors climb and decaying back as it recovers. Operators can pin a weight during an incident or contract migration. A split only a deploy can change is a constant, not a control.

**Q7 — Auth is a given component. Does it cover the onboardee, or only the client?**\
Only the client. The onboardee's magic-link session is built here, and the two must never mix.

> **Two principals, two mechanisms**
>
> The given service authenticates tenants: API keys for the API, SSO (single sign-on) for the dashboard. The onboardee has no account, so their identity is possession of the single-use link, whose hash is a session scoped to one flow's submission endpoints, expiring with the key, spent on use. An onboardee token that could reach client-scoped endpoints would be a privilege-escalation path from an email inbox.

**Q8 — Three different things here are called a key. Are they constructed the same way?**\
No, three constructions, because they defend against three different failures.

> **Who issues it, and what it is made of**
>
> The client's `Idempotency-Key` is theirs: a UUID (universally unique identifier), opaque to us and never parsed, unique within `(client_id, endpoint, key)` so one tenant cannot collide with another and the same key on a different route is caught. It is bound to a digest of the request body, the part people skip: without it, a client that reuses a key by accident is served the answer to an earlier question instead of an error.
>
> The keys we send follow one rule: build them from the durable row that survives the retry, never at send time. The webhook's is `outbox.event_id`; the email vendor's is built from the task row's id. A key generated when sending is fresh on every attempt and collapses nothing.
>
> The magic-link token is not an idempotency key and meets a different standard: 256 bits from a CSPRNG, stored only as its SHA-256, because it defends against guessing, not duplication. It is deliberately not a self-validating token, since single-use and revoke-on-resend both need server state. And an operation already repeatable by construction earns no key: webhook replay re-emits the same `eventId`, so running it twice is running it once.

**Q9 — The guards are races: duplicate-first, the zombie write, simultaneous legs. How do you prove they hold?**\
By making each race a deterministic test: the guards are SQL, so the races replay as two open transactions in a harness.

> **Reproducing the races**
>
> Stage each race explicitly instead of hoping load finds it. Duplicate-arrives-first: deliver the same callback twice, second copy first, and the inbox constraint must abort one transaction whichever order commits (Q1). The zombie: claim a task, expire its lock by hand, let a competitor finish the flow, then let the original commit, and its guarded transition must update zero rows (Q2). The collector: complete the last two sanction legs in two concurrent transactions, and exactly one may conclude the flow (dive 3). Failover joins the rota: promote the standby with acknowledged commits in flight and assert every outbox row survived. None of it needs fault-injection infrastructure; a race is two sessions and a held lock, repeatable in CI (continuous integration).

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The biggest flaw, named first: one Postgres per region is a single writer and a single point of failure, a choice and not an oversight.** Every risk below follows from taking that trade deliberately.

### What it buys
<!--meta polarity=pro-->

- **The write/publish gap is closed by construction.** Transition, outbox event and follow-up tasks commit atomically, so the client can never be un-told something the database believes.
- **Waits are rows.** A human taking a day or a vendor down for six hours costs storage, not connections, threads or timeouts.
- **The exits are pre-named.** A broker or an engine slots in at the outbox boundary additively, so no step on the scaling path is a rewrite.
- The business enum stays the five-state model a client and an auditor can read, with operational facts on task rows, off the contract.
- Every moving part is inspectable with SQL: a stuck flow, a dead task or an unpublished event is one query.

### What it gives up
<!--meta polarity=con-->

- **Postgres is the single point of failure.** Consistency was chosen over availability, so an outage stalls every write until the standby takes over; the synchronous standby also adds a round trip to every commit, and writes stop if the standby is lost (see dive 4).
- **Throughput is capped by vendor contracts** and their ~6h/week downtime, a procurement lever and not an engineering one (see dive 4).
- **PII concentrates blast radius** in one vault and one database (see dive 6 and dive 7).
- **Each region is an island, by requirement.** A regional outage is downtime for that region's clients, region-scale loss means a documented restore, and N regions multiply cost and config drift (see dive 7).
- A blocking list nobody can reach holds the flow open until a human decides, and a caveated clear asks the client to read which list was missed (see dive 3).
- A down client webhook piles up owed results until it returns, carried by redelivery and replay, while delivery claimed per tenant keeps one dead endpoint from holding the pool (see dive 3).
- Queue-in-DB churns the task table as volume grows, with the broker exit named in Right-sizing.

## What's expected at each level
<!--meta block=levels-->

### Mid-level

- Asks about volume before designing, and scopes the design to the answer: ~100 onboardings a week, so no broker, search index or read cache.
- Reads the sequencing out of the brief: sanctions screening runs after verification, not in parallel with it.
- Produces the five-state flow with a queue in front of the vendor calls.
- Walks the failure paths when prompted, rather than only the happy one.

### Senior {#levels-h3-2}

- Separates operation state from business state unprompted, and says why the seam pays.
- Closes the write-then-crash-before-publish gap with an outbox in the same transaction as the transition.
- Reaches for `FOR UPDATE SKIP LOCKED` competing workers, and argues why no broker at this volume.
- Raises DB-level tenant isolation (RLS) rather than trusting application-side filters.

{#levels-ul-2}

### Staff+ {#levels-h3-3}

- Answers the duplicate-that-arrives-first trap: a sender-keyed inbox row in the same transaction as the effect.
- Names where breaker state lives and what moves the fallback weights, the mechanism and not just the intent.
- States the CAP (consistency, availability, partition tolerance) position and points at the one eventually-consistent surface.
- Prices the broker and workflow-engine exits against the triggers set in Right-sizing.
- Defends the single-writer Postgres as the design's biggest flaw, chosen deliberately.

{#levels-ul-3}

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Orchestration & state**

- [Saga](../patterns/distributed/coordination/saga.md) — verify, screen and notify are local transactions sequenced by the state machine, with explicit failure states instead of a transaction manager spanning the vendors
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — the flow row plus its task queue is a hand-rolled durable orchestrator — every transition is persisted, so a crash or deploy resumes mid-flow instead of restarting it
- [Outbox](../patterns/distributed/coordination/outbox.md) — every state transition commits with its outbox event in one Postgres transaction, closing the write-then-crash-before-publish gap
- [Inbox](../patterns/distributed/coordination/inbox.md) — every vendor callback lands as an inbox row unique on flow, step and the provider's own request id, in the same transaction as its effect — so a duplicate that arrives before the outbox write still collides
- [Replication](../patterns/distributed/coordination/replication.md) — a synchronous in-region standby gives the single writer failover without giving up its consistency stance
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — every transition carries WHERE state = expected AND version = seen, so a zombie worker's late write updates zero rows instead of double-applying

**Vendor resilience**

- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — one breaker per vendor with its state in the shared cache, so every worker replica sees the same open circuit and one probe decides recovery
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — vendor calls and webhook deliveries retry on a growing schedule recorded on the task row's run_after before the sweeper escalates them
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — every task and every sanctions leg carries its own deadline, because no vendor publishes a latency bound and the sweeper needs a line to enforce
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — each vendor gets its own worker pool, so a stalled sanctions vendor cannot starve ID verification or the email invites
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — one scheduled job re-queues expired task locks, escalates exhausted tasks to a dead state, breaches the service level agreement (SLA) out loud to operator and client, and runs both recheck clocks
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — the sweeper and both recheck clocks each hold a renewable lease in the shared cache, so a second replica waits instead of double-firing an escalation or buying a vendor screen twice
- [Anti-Corruption Layer](../patterns/ddd/acl.md) — each vendor gets a translator that parses its payload and maps it onto our own three-valued outcome — and stamps provider and policy version onto the transition, so the history can answer how a person was verified
- [External Configuration Store](../patterns/distributed/coordination/external-configuration-store.md) — the list roster, each list's criticality, the recheck cadences, vendor quotas and fallback weights move without a deploy — and a worker that cannot reach the store boots from its last cached version rather than from defaults

**Queue & delivery**

- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the task table is the queue that absorbs onboarding bursts and six-hour vendor outages ahead of fixed vendor rate limits
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — stateless worker replicas compete for tasks with FOR UPDATE SKIP LOCKED, so two never claim the same row and adding capacity is just adding replicas
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — a task that exhausts its retries is parked in a dead state — alerted to an operator, surfaced to the client as a failure event, re-runnable after the cause is fixed
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — the sanctions step fans out one task per list and a collector transitions the flow exactly once, when every leg has reported
- [Idempotency](../patterns/messaging/idempotency.md) — four boundaries, four dedup keys, each issued by whichever side can actually see the duplicate — a stored client key, the vendor's own request id, the task row's id, the event id
- [Correlation Identifier](../patterns/messaging/correlation-identifier.md) — one flow id threads transitions, tasks, vendor calls and delivery attempts, so support reconstructs any flow with a single query
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — webhook delivery claims a flow rather than an event and sends its owed results in outbox order, so a re-screen's corrected verdict cannot overtake the one it corrects

**Capacity & admission**

- [Priority Queue](../patterns/messaging/priority-queue.md) — live flows and the recurring recheck batch share one task table, so recheck tasks claim from a separately sized pool — reserved capacity per class, because the batch's jurisdiction cadence is a deadline too
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — worker pools scale on the age of their oldest pending task, never on processor load — these pools sit blocked on vendor calls, so central processing unit (CPU) stays flat while the queue starves
- [Backpressure](../patterns/concurrency/backpressure.md) — flow creation answers 429 with a Retry-After once the live class's oldest pending task passes its ceiling — the queue is load-levelling, not an unbounded promise
- [Batching](../patterns/concurrency/batching.md) — the recurring re-screen sends ~500 persons per list-vendor call, and applies the response one member per transaction so a bad record dead-letters its own leg while the rest commit

**Payloads & PII**

- [Object Storage](../patterns/distributed/routing/object-storage.md) — ID photos go straight to an object store by presigned upload, referenced by key from a metadata row written before the upload
- [Valet Key](../patterns/distributed/routing/valet-key.md) — the ID photo goes up on a presigned URL scoped to one object for fifteen minutes, so the application programming interface (API) tier decides who may upload and then leaves the data path entirely
- [Claim Check](../patterns/messaging/claim-check.md) — workers pass the photo's storage key between steps, never the image bytes
- [Secure Logger](../patterns/security/secure-logger.md) — log lines carry flow and person ids only — the encrypted vault is the single place raw personally identifiable information (PII) exists, so logs never become a second copy of it

**Tenancy & restraint**

- [Secure Session Manager](../patterns/security/secure-session-manager.md) — the onboardee has no account: their session is the magic link's hash — server-side state, single-use, 48-hour expiry, revoked the moment a resend supersedes it
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — per-client limits at the application programming interface (API) edge keep one tenant's onboarding burst from consuming the shared vendor quota, and bound the invite-resend endpoint
- [Keep It Simple (KISS)](../principles/kiss.md) — one Postgres and stateless workers carry a confirmed hundred onboardings a week; every rejected broker and engine is priced against that number, with named exits instead of early adoption
- [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md) — residency is one full stack per region — gateway, application programming interface (API), workers, Postgres and standby, vault, object store — stamped from the same infrastructure-as-code so only jurisdiction config varies

**Alternative to**

- [Persona Identification & Sanction Check (V2)](./persona-identification-v2.md) — the same brief argued from the delivery contract — read it when the grading is on exactly-once in effect, the four dedup boundaries and the recovery ladder rather than on the storage core

**Exposed to**

- [Poison Message](../hazards/poison-message.md) — a malformed vendor response is the case the retry budget exists for: attempts and max_attempts stop it burning a worker slot, and the dead row is what an operator reads

**Demonstrates**

- [Fan-Out](../patterns/messaging/fan-out.md) — Each person check fans out to about four sanctions lists, roughly 40k screening legs a day
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — The public edge is a gateway in front of the intake service, separate from the schedulers that run on their own clock
- [Distributed Cache](../patterns/caching/distributed-cache.md) — A small shared cache holds circuit-breaker state so every worker sees one view of a vendor's health
- [Thread Pool](../patterns/concurrency/thread-pool.md) — One worker pool per vendor means a stalled sanctions vendor cannot starve ID verification
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — A flow's current state sits on its own row while every transition is appended, so the audit view is a projection over those rows

<!-- relationships:end -->
