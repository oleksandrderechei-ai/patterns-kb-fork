---
title: Persona Identification & Sanction Check (V2)
description: "The same identity-and-sanctions flow argued from its delivery contract: exactly-once in effect, and a clock on everything that can stall"
area: designs-advanced
owner: Oleksandr Derechei
tags: [event-driven, durability, asynchrony, error-handling]
status: stable
solves: [our webhook consumer processed the same result twice and the customer got charged twice, a provider went quiet weeks ago and nobody noticed the checks were still sitting open, we replayed the queue after an incident and half the work got applied a second time, the client acted on an old answer because two updates reached them out of order, work piled up behind a slow provider for hours and we were still accepting more of it]
---

# Persona Identification & Sanction Check (V2)

A client starts a flow with an email address; the address's owner submits personal information and an ID photo, a given external service verifies the ID, external sanction lists screen the person, and the result reaches the client on a webhook. Authentication, ID verification, sanction checks and email sending already exist, so the problem is everything between them: a flow waits days on a person and hours on a vendor while carrying one client's regulated data. Slow is acceptable; a wrong outcome, or none, is not. [The first page](persona-identification.md) argues the same brief on a mutable flow row plus an outbox; this page argues it on an append-only log where the record is the outbox.

## Understanding the problem
<!--meta block=description-->

The same identity-and-sanctions flow, argued from its delivery contract. The task gives no volumes, jurisdictions or data-protection rules, so the requirements mark each assumption. A flow mostly waits on vendors and people, so the page argues exactly-once-in-effect delivery and a deadline on everything that can stall.

## Explained
<!--meta block=explain-->

This design is a service that checks one person's identity for a client, screens that person against the sanction lists their country requires, and reports the result to the client's webhook (a web address the client registers). Use it when the real work happens at outside vendors that can answer twice, late or never, so no vendor call sits in the request path. Every change is appended to one log in a single Postgres transaction together with its follow-up tasks, so the history and what the client was told are the same rows. Every wait is a stored task with a deadline, and a sweeper (a scheduled job that looks for overdue work) catches anything that stalls. While the database and the pager are up, a flow finishes or raises an alert.

- **Duplicates.** Delivery is at-least-once, so the client must drop repeats by event id or it acts twice.
- **Refusals.** When hours behind, the service answers new requests with 429 and a retry time instead of queueing them.
- **Regional copies.** Residency means one full stack per region with no failover between regions, so cost multiplies.
- **Waiting.** A vendor outage makes flows wait hours instead of failing, so clients see delay, not errors.

**Example.** Fewer than 75 person-flows arrive a day, and the design is sized for 10,000. An invited person has 48 hours to use the single-use link. The identity vendor is down about 6 hours a week, so a flow that meets the outage waits as a stored task instead of failing. If a flow passes its state deadline, an operator is paged within 15 minutes, and the client's failure event follows within 5 minutes of that page, so nobody outside hears before the team does.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

**Mandatory — the promise, including the guarantees**

- A client starts a flow for one person by giving an email address.
- The create returns the flow's identifier before any work runs.
- A repeated create for the same open client-and-email pair returns the existing flow rather than starting a second one.
- The email's owner receives a single-use invitation link that expires after 48 hours.
- The email's owner can ask for a fresh link when the first one expires or is lost.
- The submitted personal information and identity photo are verified through the given identity provider.
- Screening against the sanction lists a jurisdiction requires runs only after verification passes.
- A flow concludes only once every required list has finished for that round: answered, or recorded as unreachable.
- Every concluded result reaches the client on their registered webhook.
- A result delivered more than once is recognisable to the client as a repeat of one it already holds.
- Two results for one flow reach the client in the order the system produced them.
- Every accepted flow reaches a finished state or raises an alert.

**Additional — recovery, ongoing obligations and governance** {#requirements-h-additional}

- A flow that cannot proceed produces a failure event the client receives on the same channel as a result.
- A client can ask for a flow's client-visible events to be re-sent, and the re-sent copies stay recognisable as repeats.
- A concluded flow's sanction screening is re-run on a cadence set per jurisdiction.
- Identity is re-verified from a fresh document when the current one expires or is revoked.
- A verdict changed by re-screening or re-verification is delivered exactly as the first one was.
- A client can record that its relationship with a person has ended, and that ends every recurring obligation for them.
- Each sanction list is blocking or advisory for its jurisdiction: when it is unreachable, a blocking list holds the flow for a human and an advisory list concludes it with the gap named and a re-screen booked.
- Every state change is recorded, and any flow's full history can be reconstructed after the fact.
- Personal data is kept in a store of its own, separate from the flow's recorded history.
- Every access to personal data is recorded with who read it, when, and for what purpose.
- A flow and its history can be read step by step in the dashboard.

{#requirements-ol-additional}

### Non-functional
<!--meta requirement=nfr-->

- **Consistency**
  - The recorded history and what the client was told never diverge.
  - A state change and the client-visible fact it produces commit together or not at all.
- **Delivery & idempotency**
  - Transport is at-least-once and the effect at every boundary is idempotent, which is exactly-once in effect and the strongest honest promise.
  - A repeated or replayed input (a create, a callback, a batch member, a delivery) leaves the system in the state its first arrival produced.
- **Reliability & recovery**
  - Nothing can stall without a clock that notices: every state and every vendor leg carries a deadline the system enforces.
  - The identity vendor is unavailable ~6 hours a week; flows wait, and an outage shorter than the flow's own deadlines never fails one; a longer one ends the flow at its deadline.
  - Every failed step retries on a bounded budget, then dead-letters with its diagnosis and an alert, and is re-runnable once the cause is fixed.
  - A crashed worker or scheduler costs time, never a fact; the system refuses work it cannot drain, and a database failover loses no acknowledged fact.
- **Scale**
  - ~100 merchant onboardings a week today (assumed, not given; confirm first, since every capacity decision is priced against it); one merchant means several person-flows.
  - Headroom to 10k person-flows a day without redesign.
  - Recurring re-screening grows with the book of open relationships, not with daily intake, must never starve live flows, and is bounded by relationships still open rather than everyone ever checked.
- **Observability**
  - One flow id correlates every recorded fact, task, vendor call and delivery attempt.
  - Alarms fire on stuck flows, per-class backlog age, per-vendor error rates, stalled delivery lanes and dead work.
  - An operator is paged within 15 minutes of a flow passing its state deadline, and the client's failure event follows within 5 minutes of that page, so nobody outside hears first (both numbers assumed, not given).
  - Every alarm ships with what it means, how to diagnose it and how to recover.
- **Compliance**
  - Verified documents are stored as evidence, not proxied.
  - Name, date of birth and ID photo are personal data about people who are not our customers; a cross-client leak is a reportable incident.
  - Producible on demand: a flow's full history, the record of everyone who read its personal data, and proof that data was destroyed.
  - Personal data is encrypted at rest and right-to-forget is honoured and provable; no identifier kept outside the personal-data store can re-identify an erased person.
  - Retention is a per-jurisdiction policy counted from the end of the relationship, enforced and evidenced by the system.
- **Security & tenancy**
  - Tenant isolation is enforced by the database itself, not by application filters alone.
  - Internal services and data stores are reachable only over a private network, never from the public internet.
  - Inbound callbacks and outbound webhooks are both authenticated; invitation links cannot be reused.
  - Each client belongs to a region recorded at onboarding, and their data stays in it.
- **Evolvability**
  - A deployment meeting only the mandatory requirements is a complete, correct product on its own.
  - Each additional obligation attaches to the recorded history of the mandatory flow without redesigning it.
  - A new jurisdiction, list or vendor changes configuration and cadences, not the shape of the system.

### Out of scope

- **Cancelling a flow in flight** — a started flow runs to a finished state or is abandoned once its deadline passes. {#requirements-oos-1}
- **Status polling in flight** — recovery is replay plus the dashboard, not a second read path with its own consistency story. {#requirements-oos-2}
- **Cross-region failover** — regional isolation for residency is in scope; surviving the loss of a region is not. {#requirements-oos-3}
- **Human review of a possible match** — vendors return an adjudicated verdict, so no review state exists here. {#requirements-oos-4}

## Right-sizing
<!--meta block=sizing-->

**The problem:** ~75 person-flows a day today against a design target of 10k, each one idling for days on a person and for hours on vendors nobody here operates. **The shape:** event-driven on an append-only log, because the waits outlive any request and the delivery promise needs a record that no second write can contradict. **The stores:** five in every region. Operational Postgres holds the log, projections, task queue, inbox and delivery cursors behind a synchronous standby; an encrypted vault holds personal data; a key manager holds envelope keys the application can use and never export; object storage holds documents; a coordination cache holds breaker state, provider weights, rate counters and scheduler leases. Residency makes the deployment unit a full stack per region, so every figure below is per region, sized by the largest.

### Required capabilities {#sizing-h-capabilities}

**Durable transactional store → NFR: consistency** {#sizing-cap-1}

The ingress dedup row, the state change, the evidence and the client's event commit together or not at all (mandatory).

**Append-only history as the system of record → FR: history; NFR: compliance** {#sizing-cap-2}

The auditor's question is answered from the record the system ran on (mandatory).

**Publishable record → FR: result; NFR: consistency** {#sizing-cap-3}

The relay reads the record itself, so no second table can drift from it (mandatory).

**Ingress deduplication keyed by the sender → NFR: delivery & idempotency** {#sizing-cap-4}

A duplicate that arrives before this system has written anything must still collide (mandatory).

**Work queue with leases, budgets and deadlines → NFR: reliability & recovery** {#sizing-cap-5}

Every wait is a row, and every row has a clock (mandatory).

**Per-flow ordered delivery → FR: verdict ordering** {#sizing-cap-6}

A re-screen can flip a verdict, and a stale clear must never overtake a hit (mandatory).

**Coordination cache → NFR: reliability & recovery** {#sizing-cap-7}

One breaker record, one weight set and one rate counter per vendor, plus the schedulers' leases (mandatory).

**Admission control → NFR: reliability & recovery** {#sizing-cap-8}

The system refuses work it cannot drain instead of hiding it in a queue (mandatory).

**Rate limiting, inbound and outbound → FR: re-invite, replay; NFR: reliability & recovery** {#sizing-cap-9}

Every vendor quota is a contracted ceiling, self-serve resend is a mail cannon if nobody counts it, and replay is the one amplifier a client can pull on themselves (mandatory).

**Private network and a single public edge → NFR: security & tenancy** {#sizing-cap-10}

Only one tier faces the internet (mandatory).

**Object store → NFR: compliance** {#sizing-cap-11}

Documents kept as evidence, in the client's region (mandatory).

**Encrypted personal-data store with key custody → FR: separate PII store; NFR: compliance** {#sizing-cap-12}

One envelope key per person, held where the application cannot export it (additional).

**Scheduler with leader election → FR: re-screening, failure notice** {#sizing-cap-13}

The sweeper and both recheck clocks are singletons; a second copy re-invites people and re-spends vendor quota (additional).

**Elastic worker capacity → NFR: scale** {#sizing-cap-14}

The recurring book outgrows live intake by an order of magnitude within three years (additional).

### The numbers — every figure is per region, and the largest region dominates {#sizing-h-numbers}

**Writes → NFR: scale** {#sizing-num-1}

One flow commits ~12 appends with a projection update behind each, 7 task rows touched on claim and on completion, ~5 inbox rows, and single rows for the idempotency key, the invite key, the document and two audit entries: call it 50 row-writes. At 10k flows/day, doubled for business-hours bunching, that is ≈ **6 row-writes/s, ~12/s peak**, against a primary that stays comfortable to ~100 writes/s (an assumption to measure, not a measured limit). These rows commit inside the transaction that makes the record and the client's event one fact, so this is what the guarantee costs.

**Claim polling → NFR: scale** {#sizing-num-2}

Nine workers (three pools of three replicas) each asking every 200 ms put ≈ **45 claim queries/s** on the primary. The partial index on claimable rows makes that nothing; without it the query decays into a scan that grows with the table, so the index ships on day one.

**Delivery scanning → FR: result; NFR: scale** {#sizing-num-3}

The relay claims flows rather than events, so its read is one indexed lookup per owed lane. At 10k flows/day and ~3 client-visible events each that is **under 0.4 deliveries/s**, and the partial index on unpublished work keeps it that cheap as the log grows.

**Metadata storage → NFR: scale** {#sizing-num-4}

~8 KB per concluded flow: ~12 events of ~300 bytes payload each, the projection rows they fold into, and about half as much again in indexes. × 3.65M flows/year ≈ **29 GB/year** from live intake.

**Recheck storage → FR: relationship close; NFR: scale** {#sizing-num-5}

A quarterly round costs ~6 appends and 4 round rows, about 3.6 KB. Year three carries 10.9M open relationships at four rounds apiece: 43.6M rounds ≈ **157 GB/year and rising with the book**. That is the dominant storage term, and it compounds with open relationships while revenue tracks only new ones.

**Documents → NFR: compliance** {#sizing-num-6}

One 2 MB photo per flow at 10k/day accrues ≈ **7.3 TB/year**. Under an assumed three-year mean relationship and five years of retention counted from its end, the store settles near 58 TB: intake sets how fast it fills, and the retention clock sets where it stops.

**Outbound vendor calls → NFR: scale** {#sizing-num-7}

Live intake runs 4 lists × 10k/day ≈ 0.5 legs/s. The year-three recheck book adds 478k legs/day ≈ **5.5 legs/s, twelve times live intake**, and the contracted rate binds before any compute does.

**Waiting (Little's law) → NFR: reliability & recovery** {#sizing-num-8}

A ~24 h mean wait on the person against 10k/day leaves ≈ **10k flows parked** at any moment. They are inert rows the claim query never touches, cleared by the 48-hour link expiry, two automatic re-invites and a seven-day sweep that expires the flow and tells the client.

### Verdict per candidate — what the system runs, and the exits it defers against a named trigger {#sizing-h-verdicts}

**Interaction shape: synchronous request/response against an event-driven core → NFR: consistency** {#sizing-verdict-1}

**Rejected**: synchronous request/response, because a person takes ~24 h and the identity vendor is dark ~6 h a week, so no request can stay open that long. **Adopted**: an event-driven core, where every wait is a durable row and every change an appended fact.

**Append-only log as the system of record → FR: history; NFR: consistency, compliance** {#sizing-verdict-2}

**Adopted**: the auditor's evidence and the client's event are one append, leaving no second write to contradict the first.

**A cursor per flow over the log → FR: verdict ordering** {#sizing-verdict-3}

**Adopted**: it is the outbox's relay without the outbox's table, and it makes per-flow order a property of the claim rather than of the network.

**Inbox keyed on the sender's own request id → NFR: delivery & idempotency** {#sizing-verdict-4}

**Adopted**: a repeat can land before this system has written anything, so the key must come from the side that sees both copies.

**An inbox row on every ingress, not only vendor callbacks → NFR: delivery & idempotency** {#sizing-verdict-5}

**Adopted**: a batch member and a client create are as duplicate-prone as a callback, and three mechanisms for one property are three places to get it wrong.

**Same-transaction projection → NFR: consistency** {#sizing-verdict-6}

**Adopted**: a read model that commits with the log cannot lag it, and one whose shape changes is rebuilt from the log instead of migrated.

**Work queue as a table in the same store → NFR: consistency, scale** {#sizing-verdict-7}

**Adopted**: the task insert rides the transaction of the append that created it, and skip-locked claiming makes the table a capable competing-consumers queue at ~12 writes/s.

**Deadline columns on states and legs → NFR: reliability & recovery** {#sizing-verdict-8}

**Adopted**: a vendor that accepts a call and goes silent produces no event, so only a clock the system owns can notice.

**Bounded retry with a dead state on the task row → NFR: reliability & recovery** {#sizing-verdict-9}

**Adopted**: an attempt budget plus a recorded last error turns a poison task into a row in an operator's inbox instead of a loop nobody sees.

**A third leg outcome for "unreachable" → FR: fan-in, list criticality** {#sizing-verdict-10}

**Adopted**: a two-valued verdict gives an unanswerable leg no way to finish, so a withdrawn list becomes our permanent stall.

**Leases on schedulers and on claimed tasks → NFR: reliability & recovery** {#sizing-verdict-11}

**Adopted**: one mechanism recovers a crashed worker and a crashed scheduler, and a second copy of a clock re-invites people and re-spends quota.

**Admission control at the edge → NFR: reliability & recovery** {#sizing-verdict-12}

**Adopted**: refusing a create with a retry hint costs the client less than accepting it into a backlog already hours deep.

**Rate limiters counted in the shared cache rather than per process → FR: replay; NFR: reliability & recovery** {#sizing-verdict-13}

**Adopted**: a per-process limiter divides the vendor's contracted ceiling by however many replicas run, so it wastes the quota or breaches it. The same counters meter client-facing replay, the one amplifier a client can pull on themselves.

**Elastic worker pools driven by queue age → NFR: scale** {#sizing-verdict-14}

**Adopted**: a pool blocked on vendor calls reports no processor load worth reading, while its oldest pending item's age reports everything.

**Batched vendor calls for the recurring book → NFR: scale** {#sizing-verdict-15}

**Adopted**: roughly 500× on the binding constraint, the whole distance between fitting the contracted rate in year three and reopening the contract.

**Separate encrypted vault with a key manager → NFR: compliance** {#sizing-verdict-16}

**Adopted**: erasure must be provable, and a destroyed key proves what a delete somebody was trusted to run only asserts.

**Object store → NFR: compliance** {#sizing-verdict-17}

**Adopted**: evidence and residency force it, and at tens of terabytes of immutable blobs it is also the cheapest home.

**Coordination cache → NFR: reliability & recovery** {#sizing-verdict-18}

**Adopted** for correctness, not speed: with breaker state per process, N replicas each pay for the same outage and then send N probes at a vendor that is barely back.

**Synchronous in-region standby → NFR: reliability & recovery** {#sizing-verdict-19}

**Adopted**: the standby acknowledges every commit before the client does, so promotion loses no acknowledged fact.

**Message broker → NFR: scale** {#sizing-verdict-20}

**Deferred**: it buys throughput this system does not need and pays with the shared transaction that makes the guarantee. The trigger is measured task-table churn, roughly sustained 100k flows/day, and the log crosses that move untouched.

**Workflow engine → NFR: evolvability** {#sizing-verdict-21}

**Deferred**: a log plus a task table is already durable, inspectable orchestration. The trigger is flow variants multiplying, and the price is handing an append-only history over to the engine's own.

**Log partitioning by time → NFR: scale** {#sizing-verdict-22}

**Deferred**: the trigger is a region's log passing roughly 500 GB, which the recheck arithmetic reaches in year three or four, depending on how fast the book grows.

**Read cache and search index → NFR: scale** {#sizing-verdict-23}

**Rejected**: the dashboard reads by primary key and never asks "find flows matching", and 12 writes/s peak puts no read pressure on the primary.

### When this stops being right → NFR: scale {#sizing-h-limits}

At the 10k/day target nothing in the guarantee chain wears out: the writes, the lanes and the clocks keep the headroom the arithmetic shows. What wears out is the obligation itself. Every open relationship commits this system to a round on every list, every quarter, for as long as it lasts, so outbound legs track the accumulated book while income tracks only new business: twelve times live intake by year three, against a rate priced for today. Watch one ratio, outbound legs per second per vendor over the contracted ceiling, plotted beside new flows per day; the day the two lines diverge is the day the bill stopped following the business, well before anything technical complains. Then take the exits in order: batching (adopted, worth roughly 500×), staggered cadences so a jurisdiction's rounds spread across its quarter, a renegotiated contract with the curve in hand, and log partitioning once a region passes ~500 GB. Cheapest, and underneath all of them: honouring relationship close.

## Core entities & data design
<!--meta block=entities-->

Four tables carry the delivery contract: `flow_event` is both the record and the publish queue, `inbox` is where every duplicate ingress collides, `task` holds every clock and budget, and `delivery_cursor` is the one lane per flow that makes order a property. Everything else is state folded from the log, evidence, or tenancy. Two seams sit in the schema rather than in a convention: personal data lives in a vault the operational store reaches only through an opaque `person_ref`, and operational bookkeeping never reaches the log. Every client-scoped table carries `client_id`, because a row-level-security policy cannot reach a table without the column.

~~~mermaid caption="How the delivery-contract tables join. `flow` is folded from `flow_event` rather than stored beside it, so nothing here can disagree with anything else here."
erDiagram
    direction LR
    CLIENT ||--o{ FLOW : "owns — client_id is on every table"
    CLIENT ||--o{ IDEMPOTENCY_KEY : "retries are scoped to"
    FLOW ||--o{ FLOW_EVENT : "IS folded from — the only write"
    FLOW ||--|| DELIVERY_CURSOR : "has exactly one ordered lane"
    FLOW ||--o{ INBOX : "dedups every ingress for"
    FLOW ||--o{ TASK : "spawns work that carries clocks"
    FLOW ||--o{ SCREENING_ROUND : "tallies its fan-in per round"
~~~

~~~mermaid caption="What a flow hangs off: its owner, the person behind it and the evidence. `person` is reached only through `person_ref`, so the operational store never holds the identity it decides about."
erDiagram
    CLIENT ||--o{ PERSON_RELATIONSHIP : "opens and closes"
    CLIENT ||--o{ AUDIT_LOG : "is audited in"
    PERSON_RELATIONSHIP ||--o{ FLOW : "governs the clocks of"
    PERSON ||--o{ FLOW : "reached by person_ref only"
    PERSON }o--|| KEY_MANAGER : "sealed under an envelope key"
    FLOW ||--o{ MAGIC_LINK_KEY : "is entered through"
    FLOW ||--o{ VERIFICATION_SESSION : "records attempts of"
    VERIFICATION_SESSION ||--|| DOCUMENT : "evidences"
    DOCUMENT }o--|| OBJECT_STORE : "bytes live in"
~~~

### The delivery contract — operational Postgres {#entities-group-1}

- **FlowEvent** — The system of record and the publish queue in one table. `client_visible` is the outbox predicate: the relay's queue is a filter over this table, so no second row can disagree about what the client was owed.

  ```sql summary="schema — flow_event"
  CREATE TYPE flow_event_type AS ENUM (
    'flow_created', 'invite_issued', 'invite_superseded', 'submission_received',
    'document_stored', 'idv_requested', 'idv_passed', 'idv_failed',
    'screening_started', 'list_reported', 'screening_concluded',
    'reverification_started', 'relationship_closed', 'flow_expired', 'flow_stuck');

  CREATE TABLE flow_event (              -- append-only; never updated
    client_id      uuid NOT NULL REFERENCES client(id),
    flow_id        uuid NOT NULL,
    seq            int  NOT NULL,        -- per-flow order
    type           flow_event_type NOT NULL,
    payload        jsonb NOT NULL,       -- round, list, verdict, provider, policy_version
    client_visible boolean NOT NULL DEFAULT false,  -- set by the appending code, never the relay
    event_id       uuid NOT NULL UNIQUE, -- the client's dedup key; SAME on every replay
    at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (flow_id, seq)           -- a second writer at the same seq collides: no lost update
  );

  CREATE INDEX flow_event_publishable ON flow_event (flow_id, seq)
    WHERE client_visible;                -- the relay's cost tracks events owed, not log size
  ```
- **Inbox** — One row per ingress, inserted in the same transaction as the effect it causes and keyed on the sender's own identifier. A client create, a vendor callback and one member of a 500-person batch all dedup through it.

  ```sql summary="schema — inbox"
  CREATE TABLE inbox (
    client_id   uuid NOT NULL REFERENCES client(id),
    flow_id     uuid NOT NULL,
    step        text NOT NULL,   -- 'create' | 'idv' | 'screen:ofac' | 'screen:ofac#batch'
    sender_ref  text NOT NULL,   -- the SENDER's id: vendor requestId, batch member key, client key
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (flow_id, step, sender_ref)
  );
  -- The first copy to commit wins; the loser rolls back its whole transaction, append included.
  -- A batch gets one row per member, so a redelivered batch applies only the members still owed.
  ```
- **DeliveryCursor** — One lane per flow, and the reason two results cannot arrive out of order. The relay claims a flow and sends only the next sequence it owes, so a lane in backoff blocks itself and nothing else.

  ```sql summary="schema — delivery_cursor"
  CREATE TABLE delivery_cursor (
    client_id     uuid NOT NULL REFERENCES client(id),
    flow_id       uuid PRIMARY KEY,
    delivered_seq int NOT NULL DEFAULT 0,  -- last seq the client 2xx'd; replay sets it back
    attempts      int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 8,  -- ~24h of backoff, then the lane dead-letters
    last_error    text,
    run_after     timestamptz NOT NULL DEFAULT now(),
    lease_until   timestamptz,             -- a relay replica holds the lane while sending
    dead_at       timestamptz              -- alerted; /events/replay is the way back
  );
  -- Advances only on a 2xx, so a later 'clear' cannot overtake the 'sanctioned' ahead of it.
  ```
- **IdempotencyKey** — The client's own retry guard, stored per tenant and endpoint. The request hash stops a client serving itself the answer to a different question when it reuses a key by accident.

  ```sql summary="schema — idempotency_key"
  CREATE TABLE idempotency_key (
    client_id    uuid NOT NULL REFERENCES client(id),
    endpoint     text NOT NULL,
    key          text NOT NULL,      -- the client's UUID, opaque to us
    request_hash bytea NOT NULL,     -- same key + different body → 422, not a wrong replay
    response     jsonb,              -- NULL while in flight; the stored 202 once complete
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (client_id, endpoint, key)
  );
  ```

### Work, clocks and recovery — operational Postgres {#entities-group-2}

- **Task** — The queue, and every operational fact the log refuses to carry: attempts, the budget that bounds them, the lease, the deadline and the last error. Its own `id` is the third dedup key, because a claim is unique when the row is claimed.

  ```sql summary="schema — task"
  CREATE TABLE task (                  -- all operational state; none of it reaches the log
    id           bigserial PRIMARY KEY, -- the claim's identity, and the email key's seed
    client_id    uuid NOT NULL REFERENCES client(id),
    flow_id      uuid NOT NULL,
    kind         text NOT NULL,        -- send_invite | verify_id | screen_list | deliver
    class        text NOT NULL,        -- 'live' | 'recheck': the reserved-capacity split
    args         jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'pending',  -- pending | processing | done | dead
    attempts     int  NOT NULL DEFAULT 0,
    max_attempts int  NOT NULL DEFAULT 8,  -- without a budget, poison retries forever
    last_error   text,
    deadline_at  timestamptz NOT NULL,  -- this attempt's own deadline
    run_after    timestamptz NOT NULL DEFAULT now(),  -- backoff with jitter lands here
    locked_by    text,
    lease_until  timestamptz,           -- renewed by a live worker; expiry is the sweeper's case
    dead_at      timestamptz            -- parked, alerted, re-runnable
  );
  CREATE INDEX task_claimable ON task (class, run_after) WHERE status = 'pending';
  -- A vendor task is done when its callback lands, not when the call is sent (dive 3).
  ```
- **ScreeningRound** — The fan-in tally: one row per list per round. Its verdict has three values so a list nobody can reach still ends, and its criticality decides what that ending costs.

  ```sql summary="schema — screening_round"
  CREATE TABLE screening_round (
    client_id   uuid NOT NULL REFERENCES client(id),
    flow_id     uuid NOT NULL,
    round       int  NOT NULL,   -- issued by the screening_started event that opened it
    list        text NOT NULL,   -- one row per list the jurisdiction requires
    criticality text NOT NULL,   -- 'blocking' | 'advisory', copied from the config store
    verdict     text,            -- NULL while pending; hit | clear | unavailable
    deadline_at timestamptz NOT NULL,   -- per leg, so a silent vendor is a breach, not a hang
    PRIMARY KEY (flow_id, round, list)
  );
  -- Count NULL verdicts WHERE round = $round, never max(round), which races.
  -- Zero left appends screening_concluded; 'unavailable' keeps that count reachable (dive 3).
  ```

### State and the lifecycle clocks — operational Postgres {#entities-group-3}

- **Flow** — Current state, folded forward in the same transaction as the append that moves it, so it never lags the log and can be rebuilt from it. Its `state_due_at` is the sweeper's predicate, so no state can be occupied indefinitely.

  ```sql summary="schema — flow"
  -- Nine states: four in flight, four finished verdict states, one finished abandoned state.
  CREATE TYPE flow_state AS ENUM (
    'initiated', 'awaiting_submission', 'awaiting_id_verification', 'awaiting_screening',
    'clear', 'cleared_with_caveat', 'sanctioned', 'invalid_id',
    'expired');
  -- 'cleared_with_caveat' is its own finished state: folding it into 'clear' would hand the client a clean answer we never had.

  CREATE TABLE flow (                    -- a projection: rebuildable, never written alone
    id           uuid PRIMARY KEY,
    client_id    uuid NOT NULL REFERENCES client(id),
    person_ref   uuid NOT NULL,          -- opaque ref into the vault
    email_mac    bytea NOT NULL,         -- HMAC under a per-region key that erasure destroys
    state        flow_state NOT NULL DEFAULT 'initiated',
    last_seq     int NOT NULL DEFAULT 0, -- how far this projection has folded
    state_due_at timestamptz             -- every in-flight state sets one
  );

  CREATE UNIQUE INDEX one_open_flow ON flow (client_id, email_mac)
    WHERE state NOT IN ('clear', 'cleared_with_caveat', 'sanctioned', 'invalid_id', 'expired');
  CREATE INDEX flow_overdue ON flow (state_due_at) WHERE state_due_at IS NOT NULL;
  -- Re-screening leaves state alone, so a recheck never makes a concluded flow look open.
  ```
- **PersonRelationship** — What the recurring obligations hang off, and the only thing that ends them. Retention counts from `closed_at`, so an object-store lifecycle rule cannot be the retention policy.

  ```sql summary="schema — person_relationship"
  CREATE TABLE person_relationship (
    client_id       uuid NOT NULL REFERENCES client(id),
    person_ref      uuid NOT NULL,
    opened_at       timestamptz NOT NULL,
    closed_at       timestamptz,          -- set by the client; ends every recurring obligation
    rescreen_due_at timestamptz,          -- NULLed on close, so the clock stops finding the row
    reverify_due_at timestamptz,          -- likewise
    retain_until    timestamptz,          -- computed from closed_at, not from the check
    PRIMARY KEY (client_id, person_ref)
  );
  -- Nulling the two due dates is the whole termination rule (dive 6).
  ```
- **MagicLinkKey** — The onboardee's whole identity: a single-use invite key with a 48-hour expiry, spent when the document lands rather than when the form posts. Redemption is a conditional write judged by rowcount, so two concurrent redemptions cannot both win.

  ```sql summary="schema — magic_link_key"
  CREATE TABLE magic_link_key (
    key_hash       bytea PRIMARY KEY,  -- SHA-256 of a 256-bit random token; never the token
    client_id      uuid NOT NULL REFERENCES client(id),
    flow_id        uuid NOT NULL,
    expires_at     timestamptz NOT NULL,  -- issued_at + 48h
    spent_at       timestamptz,           -- set when the DOCUMENT lands, not at submit
    invalidated_at timestamptz            -- superseded by a resend: a different fact from spent
  );
  -- UPDATE magic_link_key SET … WHERE key_hash = $h AND spent_at IS NULL
  --   AND invalidated_at IS NULL AND expires_at > now();
  -- Zero rows updated tells expired, forged and spent apart: three messages for the onboardee, one alarm for us.
  ```

### Tenancy, evidence and governance {#entities-group-4}

- **Client** — The tenant, and the region its data may never leave. The application connects as a non-owner role so `FORCE ROW LEVEL SECURITY` binds it on every client-scoped table.

  ```sql summary="schema — client"
  CREATE TABLE client (
    id                 uuid PRIMARY KEY,
    region             text NOT NULL,    -- recorded at onboarding; PII and documents stay in it
    webhook_url        text NOT NULL,
    webhook_secret_ref text NOT NULL     -- points into the secret store, never the secret
  );

  -- The same three lines go on every client-scoped table:
  ALTER TABLE flow_event ENABLE ROW LEVEL SECURITY;
  ALTER TABLE flow_event FORCE  ROW LEVEL SECURITY;  -- else the owner bypasses its own policy
  CREATE POLICY tenant_isolation ON flow_event
    USING (client_id = current_setting('app.client_id')::uuid);
  -- SET LOCAL, never SET: the setting dies with the transaction, not with a pooled connection.
  -- Workers, relay and sweeper claim across tenants, so they run as a separate audited principal (dive 7).
  ```
- **Person** — Email and submitted personal data, sealed under a per-person envelope key. It lives in the vault, is referenced only by id, and erasure destroys the key rather than the row.

  ```sql summary="schema — person"
  -- In the encrypted vault: a separate store with its own credentials, one per region.
  CREATE TABLE person (
    id             uuid PRIMARY KEY,     -- the person_ref the operational store carries
    client_id      uuid NOT NULL,
    encrypted_data bytea NOT NULL,       -- email + submitted personal data, sealed as one blob
    key_id         text  NOT NULL        -- per-person envelope key, held by the key manager
  );
  -- Destroying the key makes every copy noise, backups included (dive 6).
  ```
- **Document** — The photo's metadata row is written before the upload URL is issued, so a failed upload leaves a visible stub rather than an orphan blob. `presigns` bounds the re-issue endpoint so it cannot become a signing oracle.

  ```sql summary="schema — document"
  CREATE TABLE document (
    id          uuid PRIMARY KEY,
    client_id   uuid NOT NULL REFERENCES client(id),
    person_ref  uuid NOT NULL,
    storage_key text NOT NULL,      -- row first, then the presigned URL: no orphan blobs
    presigns    int  NOT NULL DEFAULT 1,  -- bounded re-issues
    uploaded_at timestamptz         -- NULL = never completed; the sweeper offers a fresh URL
  );
  ```
- **VerificationSession** — One vendor verification of one document. It carries the document's expiry date, the single value the re-verification clock reads.

  ```sql summary="schema — verification_session"
  CREATE TABLE verification_session (
    id             uuid PRIMARY KEY,
    client_id      uuid NOT NULL REFERENCES client(id),
    flow_id        uuid NOT NULL,
    document_id    uuid NOT NULL REFERENCES document(id),
    result         text,            -- NULL until the vendor's callback lands
    doc_expires_on date             -- what person_relationship.reverify_due_at is set from
    -- … provider, timestamps …
  );
  ```
- **AuditLog** — The only evidence behind "every access to personal data is recorded". It references the opaque `person_ref`, so it outlives erasure: the record that someone read the data must survive the data.

  ```sql summary="schema — audit_log"
  CREATE TABLE audit_log (         -- append-only; never carries the data it describes
    id         bigserial PRIMARY KEY,
    client_id  uuid NOT NULL REFERENCES client(id),
    person_ref uuid NOT NULL,      -- the opaque ref, never a name or an email
    actor      text NOT NULL,      -- operator id, or the service principal that read
    purpose    text NOT NULL,      -- 'dashboard_view' | 'idv_submit' | 'audit_export'
    at         timestamptz NOT NULL DEFAULT now()
  );
  -- Kept on the retention clock, not the erasure one.
  ```

## The interface — API design
<!--meta block=interface-->

Every contract states what it guarantees, which key makes a repeat safe, and what it answers when the system cannot keep the promise. State-changing client calls return `202` because the work is recorded durably and done afterwards; the onboardee's submission is the one `201`, carrying the upload URL it just created. Each boundary carries the guard held by whichever side can see the duplicate, so there is no single idempotency mechanism. When a workload class's oldest pending item passes its ceiling, `POST /flows` answers `429` with a `Retry-After`.

### Client API — tenant API key or dashboard session {#interface-group-1}

- **`POST /flows`** — Start a flow from an email. Two guards for two duplicates: the stored `Idempotency-Key` absorbs a network retry, and `one_open_flow` absorbs a repeated invite.

  ```http summary=contract
  POST /flows
  Idempotency-Key: 7c9e-4b1a-…                 client-generated UUID, opaque to us
  { "email": "jane@example.com" }              the verdict goes to the registered webhook_url

  202 Accepted
  { "flowId": "flow_9c31", "state": "initiated", "seq": 1 }
  # Same key, completed  → the stored 202 replayed byte-identical.
  # Same key, in flight  → 409 + Retry-After; never a second execution.
  # Same key, other body → 422: request_hash mismatch.
  # Different key, same email → 200 with the existing open flow (one_open_flow).

  429 Too Many Requests    Retry-After: 900
  # Admission control: the live class's oldest pending task is past its ceiling (dive 4).
  ```
- **`POST /flows/{id}/events/replay`** — Rewind the flow's delivery lane and re-emit from the record. This replaces polling, and it takes no idempotency key because every event it re-sends already carries the identifiers that make a repeat safe.

  ```http summary=contract
  POST /flows/flow_9c31/events/replay
  { "fromSeq": 0 }                             default: the last client-visible event only

  202 Accepted
  # The same eventIds in the same seq order, however often you ask: one UPDATE to
  # delivery_cursor.delivered_seq, and the relay walks forward (dive 1).
  # Rate-limited per flow: replay is the one client-triggered write that multiplies outbound work.

  409 Conflict  { "error": "delivery lane dead" }   clear the dead lane first
  ```
- **`POST /flows/{id}/invite/resend`** — Invalidate prior keys and issue one fresh single-use link with a new 48-hour expiry. It most needs the stored key: a retried resend would invalidate the link it just issued and send a second email.

  ```http summary=contract
  POST /flows/flow_9c31/invite/resend
  Idempotency-Key: b41f-90ac-…                 without it, a retry invites twice

  202 Accepted
  # Prior keys get invalidated_at; one fresh key is issued; the email's own key is built from
  # the task row's id, so attempt two presents attempt one's key (dive 2).
  # The onboardee can also reach it from the expired-link page, so a per-flow limit guards it.

  409 Conflict  { "error": "already submitted" }   nothing left to invite
  ```
- **`POST /persons/{ref}/relationship:close`** — The client says the relationship ended, and every recurring obligation for that person stops. It is the cheapest lever on the vendor bill and the only bound on the recurring book.

  ```http summary=contract
  POST /persons/prs_44f1/relationship:close
  Idempotency-Key: 3ac0-…

  202 Accepted
  { "closedAt": "2026-08-01T…", "retainUntil": "2031-08-01" }
  # One transaction: append relationship_closed, NULL both due dates, set retain_until from
  # now() on the jurisdiction's schedule (dive 6).
  # Closing a closed relationship changes nothing, so the key is belt to the braces.
  ```
- **`DELETE /persons/{ref}`** — Right-to-forget, executed as key destruction rather than a delete anyone must be trusted to have run. A live retention obligation outranks it.

  ```http summary=contract
  DELETE /persons/prs_44f1

  202 Accepted   { "erasedAt": "…" }         envelope key and email_mac key destroyed

  409 Conflict   { "error": "retention active", "until": "2031-04-01", "queued": true }
  # Scheduled, not refused: erasure runs when the obligation lapses, and the date lets the
  # client answer their data subject. flow_event and audit_log survive by design (dive 6).
  ```

### Onboardee — possession of a single-use link, and no account at all {#interface-group-1b}

- **`POST /submissions`** — The onboardee submits personal information against the magic-link session and receives a presigned URL for the photo. The link is not spent here; it is spent when the document lands.

  ```http summary=contract
  POST /submissions
  Authorization: Bearer <magic-link token>    hash looked up; expiry and single-use checked
  { "personalInfo": { … } }

  201 Created
  { "documentId": "doc_71a",
    "uploadUrl": "https://blob.example/id-photos/…?sig=…",   scoped to one key, 15 minutes
    "expiresIn": 900 }
  # spent_at stays NULL, so a failed 2 MB upload on a phone is recoverable, not a support ticket.
  # The browser PUTs straight to object storage; bytes never transit this API.

  410 Gone   { "error": "link expired", "resend": "/invite/resend?flow=flow_9c31" }
  ```
- **`POST /submissions/{documentId}/upload-url`** — Hand out a fresh presigned URL when the first PUT never landed. A phone upload of 2 MB fails often, so the way back is an endpoint that costs the onboardee nothing they are not still holding.

  ```http summary=contract
  POST /submissions/doc_71a/upload-url
  Authorization: Bearer <magic-link token>    still valid: the submit did not spend it

  201 Created  { "uploadUrl": "…", "expiresIn": 900 }
  # document.presigns bounds the asks, so the endpoint is no signing oracle. Past the bound the
  # answer is /invite/resend: a whole new link, never another URL hung off a spent one.

  409 Conflict  { "error": "already uploaded" }   uploaded_at is set
  ```

### Inbound vendor callbacks — a provider signature, deduped at the boundary {#interface-group-2}

- **`POST /callbacks/idv`** — The identity vendor reports. The inbox row and the append it causes share one transaction, so a duplicate that arrives before this system has written anything still collides.

  ```http summary=contract
  POST /callbacks/idv
  X-Provider-Signature: …                      verified before the body is parsed
  { "requestId": "idv_88c2", "flowId": "flow_9c31",
    "result": "pass", "docExpiresOn": "2031-02-14" }

  204 No Content
  # Applied once in effect, whatever the vendor's retry policy. Key: the vendor's requestId,
  # in the inbox on (flow_id, 'idv', requestId).
  # One transaction, five facts: inbox row, append at the seq we read, screening fan-out tasks,
  # projection fold, task marked done. The duplicate loses and takes its transaction with it (dive 2).

  409 Conflict   already applied: the vendor may stop retrying
  ```
- **`POST /callbacks/screening`** — One sanction list reports one leg of one round. The round is echoed from the request the system sent and never recomputed, because recomputing it is how a re-screen concludes on last quarter's answers.

  ```http summary=contract
  POST /callbacks/screening
  X-Provider-Signature: …
  { "requestId": "scr_31f", "flowId": "flow_9c31",
    "round": 4, "list": "ofac", "verdict": "clear" }

  204 No Content
  # round selects the screening_round row. Only the leg that finds zero NULL verdicts in its
  # own round appends screening_concluded, so a partial verdict cannot ship.
  # A leg the sweeper already stamped 'unavailable' is finished (dive 3).
  ```
- **`POST /callbacks/screening:batch`** — The recurring book's variant: one vendor call covers up to 500 persons. The batch is a transport optimisation and never a unit of failure.

  ```http summary=contract
  POST /callbacks/screening:batch
  { "requestId": "scr_b902", "list": "ofac", "round": 4,
    "results": [ { "flowId": "flow_9c31", "verdict": "clear" }, … ] }

  204 No Content
  # One inbox row per member, keyed (flow_id, 'screen:ofac', requestId), and one transaction
  # per member. A redelivery whose first 300 members applied applies the other 200; a member
  # the vendor could not adjudicate dead-letters its own leg while 499 commit (dive 4).
  ```

### Outbound webhook — signed by us, dedup owed by them {#interface-group-3}

- **`POST {webhookUrl}`** — Every client-visible event, in the order the flow produced it. `eventId` makes a repeat recognisable and `seq` makes the order recognisable; the client's own dedup is the last boundary, outside this system.

  ```http summary=contract
  POST {webhookUrl}
  X-Signature: sha256=…                        HMAC over the raw body, key from webhook_secret_ref
  X-Event-Id:  5f2a-…                          stable across every redelivery AND every replay
  { "eventId": "5f2a-…", "flowId": "flow_9c31",
    "seq": 11,                                 monotonic per flow
    "type": "screening_concluded", "verdict": "sanctioned", "occurredAt": "…" }

  # What you must do, and we cannot do for you:
  #   1. Treat a repeated eventId as a repeat. Apply once.
  #   2. Discard any seq lower than the highest you have applied for that flow.
  # 8 attempts on exponential backoff with jitter over ~24h, then the lane dead-letters and an
  # operator is paged; /events/replay is the way back (dive 2).
  ```

### Dashboard and audit reads — the tenant's session, under row-level security {#interface-group-4}

- **`GET /flows/{id}/events`** — The step-by-step view, read straight off the record. The auditor's export and this screen are the same query with different pagination.

  ```http summary=contract
  GET /flows/flow_9c31/events

  200 OK
  { "flowId": "flow_9c31", "state": "clear", "lastSeq": 11, "deliveredSeq": 11,
    "events": [ { "seq": 1, "type": "flow_created", "at": "…" },
                { "seq": 11, "type": "screening_concluded", "at": "…", "verdict": "clear" } ] }
  # deliveredSeq is here on purpose: "did you send it" and "did they take it" are different
  # questions, and support asks the second one more often.
  # Reads are by primary key; no free-text search. Personal fields render only through the
  # vault, and each render appends an audit_log row.
  ```

## How the system is built
<!--meta block=architecture-->

One door faces the internet and one transaction carries every fact. A client create, an onboardee submission and a vendor callback all enter through the Identification API, and each commits the same five things together: the inbox row that makes the ingress unrepeatable, the append that records what happened, the projection fold that moves current state, the follow-up tasks, and the completion of the task that caused it. Nothing is published by a second write, because the append is the publish queue and a delivery relay walks each flow's own sequence. Every wait is a durable row with a clock, so a worker crash, a silent vendor and an eight-hour backlog reach the same sweep by three routes.

```mermaid caption="How does a request become a fact and then a webhook? Steps 2 to 4 are one commit, and step 8 reads the rows step 3 wrote, which is why no outbox table appears."
flowchart TB
    Client["Client"]:::ext
    Edge["Identification API · gatekeeper — auth, limits, 429"]
    subgraph Txn["One transaction — nothing here can half-happen"]
        Inbox[("inbox — keyed by the SENDER")]
        Log[("flow_event — the record IS the outbox")]
        Proj[("flow · screening_round · task")]
    end
    Workers["Worker pools + schedulers — leased, deadlined"]
    Relay["Delivery relay — one lane per flow"]
    Vendors["IDV · sanction lists · email"]:::ext
    Client -->|"1 create — Idempotency-Key"| Edge
    Edge -->|"2 dedup the ingress"| Inbox
    Inbox -->|"3 append the fact"| Log
    Log -->|"4 fold state, enqueue work"| Proj
    Proj -->|"5 claim under a lease"| Workers
    Workers -->|"6 call under breaker + deadline"| Vendors
    Vendors -->|"7 signed callback — re-enters at 2"| Edge
    Log -->|"8 next seq this flow owes"| Relay
    Relay -->|"9 signed webhook — eventId + seq"| Client
    classDef ext stroke-dasharray:4 4;
```

```mermaid caption="Which stores and planes sit beside Postgres, and who may reach them?"
flowchart TB
    API["Identification API"]
    Workers["Worker pools"]
    Sched["Schedulers — sweeper + recheck clocks"]
    Cache[("Coordination cache — breakers · weights · rate counters · leases")]
    Config[("Configuration store — roster · criticality · cadences")]
    Vault[("PII vault")]
    KeyMgr["Key manager"]
    Docs[("Object store")]
    API -->|"seal and read personal data"| Vault
    Vault -->|"envelope key per person"| KeyMgr
    API -->|"presigned upload, storage key only"| Docs
    Workers -->|"breaker state, weights, rate counters"| Cache
    Sched -->|"hold leader leases"| Cache
    Workers -->|"roster, criticality, quotas"| Config
    Sched -->|"cadences"| Config
```

### Components & communication {#architecture-h-components}

| Component | Role, and what it talks to |
| --- | --- |
| **API gateway + Identification API** | The only surface the internet may address. It terminates TLS, authenticates the tenant, enforces per-client and per-flow limits, answers `429` when a workload class is behind, and commits an ingress row, an append, a fold and its follow-up tasks in one transaction. |
| **Postgres** | The log and everything folded out of it: `flow_event`, `flow`, `screening_round`, `task`, `inbox`, `delivery_cursor`, `idempotency_key` and `audit_log`. No personal data. A synchronous in-region standby acknowledges each commit ahead of the client's response. |
| **Worker pools** | Stateless replicas, one pool per vendor, claiming with skip-locked reads and renewing a lease while they work. A pool scales on the age of its oldest pending task, because a worker blocked on a vendor call reports no load. |
| **Schedulers** | The same fleet driven by a clock, each holding a lease so no second copy runs. One sweeper expires leases, dead-letters spent tasks, stamps unreachable legs, expires overdue flows and enforces retention; two recheck clocks re-enter concluded flows on their jurisdiction's cadence and stop when a relationship closes. |
| **Delivery relay** | Claims a flow and sends the lowest client-visible sequence above that flow's cursor. One lane per flow makes ordering a property, and its backoff, attempt budget and dead state mirror the task table's. |
| **Coordination cache** | Breaker state, provider weights, vendor rate counters and the schedulers' leases, so every replica sees one open circuit and one remaining quota. It is here for coordination, not read relief. |
| **Configuration store** | The list roster, each list's blocking-or-advisory criticality, recheck cadences, vendor quotas and provider weights. It is separate from the cache because it fails differently: a worker that cannot reach it boots from its last cached version and refuses to start without one, since compiled-in defaults would screen against the wrong lists and report success. |
| **PII vault + key manager** | Sealed person blobs behind their own credentials, and envelope keys the application may use but never export. Erasure is one call that destroys a key. |
| **Object store** | Identity photos, uploaded from the onboardee's browser on a presigned URL. Workers pass the storage key, never the bytes. |
| **Client, onboardee and vendors** | The given externals, with two auth models: a tenant API key or dashboard session, and possession of a single-use link for someone with no account. Vendor calls leave through per-vendor pools and re-enter through the inbox. |

### Where each requirement lands — one line per functional requirement, in the requirements block's order {#architecture-h-trace}

**Start a flow from an email address → FR: start** {#arch-fr-1}

Client → API → Postgres: one transaction writes the create's inbox row, appends `flow_created`, folds the projection and inserts the invite task.

**The identifier comes back before any work runs → FR: identifier returned** {#arch-fr-2}

The API answers `202` out of that same commit, and every vendor call behind it is a task row a worker claims later.

**A repeated create for an open pair returns the existing flow → FR: no duplicates** {#arch-fr-3}

The `one_open_flow` partial unique index in Postgres, not application logic.

**A single-use invitation expiring after 48 hours → FR: invitation** {#arch-fr-4}

Invite task → Worker pools (email) → email vendor; only the key's hash is stored, so a database read cannot spend the link.

**A fresh link on request → FR: re-invite** {#arch-fr-5}

The resend endpoint invalidates every prior key for that flow and issues one more, behind the gateway's per-flow limit.

**Verification through the given provider → FR: verify** {#arch-fr-6}

Worker pools (IDV) → vendor; the callback re-enters at the API as an inbox row whose append shares its transaction.

**Screening runs only once verification passes → FR: screen after verify** {#arch-fr-7}

The `idv_passed` append writes the fan-out tasks and nothing else does, so the ordering is structural.

**A flow concludes only once every list has finished → FR: fan-in** {#arch-fr-8}

Worker pools write leg verdicts into `screening_round`, the Schedulers' sweeper stamps unreachable legs, and only the leg finding none outstanding in its own round appends `screening_concluded`.

**Every result reaches the client's webhook → FR: result** {#arch-fr-9}

Postgres log → Delivery relay → Client endpoint, at-least-once with a bounded budget and a dead lane at the end.

**A repeated delivery is recognisable → FR: recognisable repeat** {#arch-fr-10}

`event_id` lives on the log row and travels with every redelivery and every replay.

**Two results arrive in the order they were produced → FR: verdict ordering** {#arch-fr-11}

The relay reads `delivery_cursor` and sends one sequence at a time per flow.

**Every accepted flow finishes or raises an alert → FR: finished or alert** {#arch-fr-12}

`flow.state_due_at` plus the Schedulers' sweep; the schema permits no in-flight state without a due date.

**Failure reaches the client → FR: failure notice** {#arch-fr-13}

The Schedulers append the failure event, and it leaves by the same relay path as any result.

**Events can be re-sent on request → FR: replay** {#arch-fr-14}

API → Postgres: one write moves `delivered_seq` back, and the relay walks the log forward with the same identifiers.

**Re-screening on each jurisdiction's cadence → FR: re-screening** {#arch-fr-15}

The recheck clock reads `person_relationship.rescreen_due_at` and opens a fresh round, leaving the flow's standing verdict where it is.

**Re-verification when a document expires → FR: re-verification** {#arch-fr-16}

The second clock re-enters at the invite, because only the person can supply a new document.

**A changed verdict is delivered like the first → FR: changed verdict** {#arch-fr-17}

The round's conclusion is an ordinary client-visible append and leaves through the same relay lane.

**Ending the relationship ends the obligations → FR: relationship close** {#arch-fr-18}

API → Postgres: one transaction appends `relationship_closed` and nulls both due dates, so neither clock can find the row.

**Blocking and advisory lists diverge when unreachable → FR: list criticality** {#arch-fr-19}

The sweeper stamps the exhausted leg unavailable, and the collector reads that list's criticality from the Configuration store to hold the flow for a human or conclude it with the gap named.

**Every change recorded, any history reconstructible → FR: history** {#arch-fr-20}

`flow_event` is the write itself, so the history is not a second artefact that could be missing.

**Personal data in a store of its own → FR: separate PII store** {#arch-fr-21}

The PII vault behind `person_ref` and photos in the Object store, so the operational database holds neither.

**Every access to it recorded → FR: access audit** {#arch-fr-22}

An `audit_log` row per vault read, carrying the reader, the moment and the purpose.

**Step-by-step dashboard view → FR: dashboard** {#arch-fr-23}

The dashboard reads that same log through the API, under the tenant's row-level-security session.

Concrete technology is named once, here, so the design above stays portable:

| Concern | Choice | Why, at this scale |
| --- | --- | --- |
| Log, projections, queue, inbox, cursors | **PostgreSQL** | The delivery guarantee is one ACID transaction across the ingress row, the append, the fold and the follow-up tasks; skip-locked claiming makes the same table a competent queue at single-digit writes/s. A broker would trade that transaction away for throughput nobody asked for. |
| Identity photos | Any object store (S3, GCS, Azure Blob) | Cheap immutable blobs; a presigned upload keeps the bytes off the API. |
| PII vault | A second PostgreSQL instance with its own credentials | Separation is the credential boundary: a compromised API tier holds `person_ref` values, not personal data. |
| Key custody | A managed key service or HashiCorp Vault | Keys the application may use and never export, so erasure is a destroy call with a receipt. |
| Coordination cache | Redis or equivalent | Breaker state, weights, rate counters and leases outlive any replica and are read on every claim. |
| Configuration store | A versioned configuration service with client-side caching | Roster, criticalities, cadences and quotas change without a deploy; the cached last-known-good version is the boot answer when the service is down. |
| IDV, sanctions, email | The given vendors | Consumed behind per-vendor pools and one translator each; their contracts shape worker design and their internals are out of scope. |
| Auth | The given internal auth service (clients); magic-link sessions (onboardees) built here | The given service covers tenant API keys and dashboard SSO; the onboardee has no account, so their session is possession of a single-use link. |
| Observability | OpenTelemetry + a metrics store (Prometheus or equivalent) | Correlation on flow id; the per-vendor error rate feeds the alarm and the provider weights from one series. |
| Message broker, workflow engine | Not yet; a managed queue and a durable-workflow engine at the exits | Adopted on the triggers Right-sizing names: task-table churn at roughly sustained 100k flows/day, and flow variants multiplying. The log survives both moves untouched. |

{#architecture-table-1}

## Deep dives
<!--meta block=deepdives-->

### 1 · Where the outbox went → NFR: consistency

**The log is the outbox: the row that records a change is the row the relay publishes, so no second write can disagree with the first.** Recording a change and telling somebody are two acts with no transaction between them. Commit first and crash, and the database holds a sanctioned verdict the client never hears. Publish first and fail the commit, and the client acts on a decision this system does not hold. The [Outbox](../patterns/distributed/coordination/outbox.md) pattern closes the gap by making the publish a second local write that a relay drains. On an [event-sourced](../patterns/architecture/event-sourcing.md) core no gap is left, because the recorded row is the published row.

So the outbox is present and its table is not. `flow_event.client_visible` is the outbox as a predicate: the relay's queue is every client-visible row above this flow's cursor, served by a partial index. An outbox is a guarantee (the change and the message commit together or neither does), not a schema.

A separate outbox table on top of the log would reintroduce the double write. Two rows would have to agree on what is publishable and in what order, and only discipline keeps them agreeing. A relay that pruned the outbox could no longer answer `/events/replay`, so replay would read the log anyway and the system would carry two publish paths with different retention. The one thing the table buys, a small hot queue, comes here from the cursor plus `flow_event_publishable`, at the cost of one index.

The merge has three costs. The relay reads the system of record on its hot path, so the counter-move is that it only reads and only writes `delivery_cursor`. Every client-visible event is retained for the life of the log, which the compliance requirement already pays for. And `client_visible` is a business decision in the record, so a mislabel leaks a step or hides a verdict; the appending code path sets it and the relay holds no policy.

```mermaid caption="Two ways to close the write-then-publish gap: a table that must be kept honest and still cannot serve replay alone, or a predicate and a cursor."
flowchart LR
    subgraph Rejected["Rejected — outbox table on a log core"]
        R1[("flow_event")] -->|"same txn"| R2[("outbox")]
        R2 -->|"drain, then PRUNE"| R3["Relay"]
        R1 -.->|"replay needs the log anyway"| R3
        R2 -.->|"can disagree about what is publishable"| R1
    end
    subgraph Adopted["Adopted — the record IS the outbox"]
        A1[("flow_event · client_visible")] -->|"partial index"| A2["Relay"]
        A3[("delivery_cursor")] <-->|"the only write"| A2
    end
```

### 2 · Four keys against a repeat, one lane for order → NFR: delivery & idempotency

**Exactly-once is unavailable on a network, so the system makes transport at-least-once and every boundary idempotent, with each key issued by the side that can see both copies.** A sender that never retries loses messages and one that retries sends duplicates. There are four places a duplicate can enter, and [the key is issued by whichever side sees both copies](../patterns/messaging/idempotency.md), never by the side that happens to be writing.

**Boundary one — the client's create** {#deepdives-h-boundary-1}

Only the client knows its second POST retries its first; this system sees two identical requests. The `Idempotency-Key` is stored per tenant and endpoint with a digest of the body, so a key reused by accident returns 422, and the stored 202 replays byte for byte so the retry learns the same flow id.

**Boundary two — vendor and batch ingress** {#deepdives-h-boundary-2}

A vendor's retry can land before this system has written a row, so a key we issue at publish time has nothing to collide with. The [inbox](../patterns/distributed/coordination/inbox.md) keys on the sender's request id and commits with the append it causes: the first copy wins and the second breaks the unique constraint and rolls back append and all. A client create writes `(flow, 'create', key)` like everything else, and a batch result writes a row per member, so a redelivered batch of 500 whose first 300 applied lands the other 200.

**Boundary three — the worker claim** {#deepdives-h-boundary-3}

The durable row is its own key: a task is claimed by locking it, so two workers cannot hold one row. A task completes when its callback lands, never when the call is dispatched, so a worker that dies after calling loses its lease, the row is re-claimed, and the duplicate callback collides in the inbox. The lease bounds how long a lost worker costs and the inbox bounds what its retry can do. A zombie whose lease expired finds its append rejected by the log's primary key.

**Boundary four — outbound delivery** {#deepdives-h-boundary-4}

The key is `flow_event.event_id`, issued once when the fact is recorded and stable across every redelivery and replay; a fresh id per attempt would collapse nothing. Keys to vendors follow the rule: the email send builds its key from the task row's id, because that row survives the retry.

**The fifth boundary — which is not ours** {#deepdives-h-boundary-5}

The system can make a duplicate recognisable; only the client's handler can make it harmless. A client that inserts a payment row per `screening_concluded` without checking `eventId` pays twice with the contract kept perfectly. Four counter-moves, none a guarantee: the payload documentation states the client's two obligations; stable identifiers keep a dedup table small; `seq` ships so the client can reject stale work by comparison; and replay is explicit and rate-limited. Claiming exactly-once end to end would claim something about somebody else's code.

```mermaid caption="Where a duplicate can enter, and who owns the key that stops it. Boundary five is drawn because it is real." wide=true
flowchart TB
    C["Client"]:::ext -->|"1 · Idempotency-Key<br>issued by the CLIENT"| API["Identification API"]
    V["Vendor / batch"]:::ext -->|"2 · sender's requestId<br>issued by the VENDOR"| API
    API --> IB[("inbox — unique per sender ref")]
    IB --> LOG[("flow_event")]
    LOG --> T[("task — 3 · the ROW is the key")]
    T -->|"claim + lease"| W["Worker"]
    W -->|"call; done only on callback"| V
    LOG -->|"4 · event_id + seq<br>issued by US, stable on replay"| R["Relay"]
    R -->|"at-least-once"| C
    C -.->|"5 · dedup on eventId —<br>OUTSIDE this system"| C
    classDef ext stroke-dasharray:4 4;
```

**The second guarantee — which none of those four keys buys** {#deepdives-h-order-guarantee}

A key settles which copy of one fact applies, not which of two facts lands first. A re-screen turns a person from clear to sanctioned: the sanctioned delivery draws a 502 and backs off, the correction behind it goes out first, and the client's ledger ends the day saying clear. Two event ids, two legitimate facts, no duplicate; every key passes and the client holds the wrong verdict.

The fix is that the relay claims a flow rather than an event. One [lane per flow](../patterns/messaging/sequential-convoy.md): take the lowest client-visible sequence above `delivered_seq`, send it, and move the cursor only on a 2xx. Backoff blocks one lane and a stale clear cannot leave ahead of the hit in front of it. `seq` also travels in the payload, so the client can drop anything below what it has applied even if the network reorders.

The price is head-of-line blocking: a flow whose client endpoint fails receives nothing until its lane drains or dies, which is right here, because a late sanctioned verdict beats an out-of-order one. Two things bound it. The lane has its own attempt budget and dies at roughly 24 hours, paging an operator, and `/events/replay` is the way back. And claiming per flow claims per tenant, so one client's dead endpoint holds only that client's lanes. The residual case is a hot flow re-screened across many jurisdictions in a day, whose events serialize: milliseconds now, and the first thing to measure at a hundred times the volume. Lanes per client would trade the guarantee down to per-tenant and need the requirement re-argued first.

### 3 · Nothing hangs without a clock that notices → NFR: reliability & recovery

**Nothing may stall without a clock that notices, because a vendor that accepts a call and goes quiet produces no event for a reactive system to see.** An error is an event to react to; silence is nothing, and a system that only reacts waits forever. So every in-flight flow state carries `state_due_at`, every task `deadline_at`, and every screening leg its own: 48 hours on an invitation with two automatic re-invites and a seven-day flow expiry, 24 hours on a verification callback, 4 hours on a screening leg with the round breaching at 12. Silence becomes a breach of a number the system owns.

**Rung one — bounded retry** {#deepdives-h-rung-1}

A failed attempt moves to `run_after` with [exponential backoff and jitter](../patterns/distributed/resilience/retry-backoff.md); without jitter a cohort that failed together returns together, and six hours of downtime ends in a stampede. `attempts` counts, `max_attempts` stops, `last_error` is what an operator reads, and `dead_at` parks the task in a [dead-letter](../patterns/messaging/dead-letter-channel.md) state that alerts and can be re-run. Drop the budget and one malformed response owns a worker slot forever; drop the error and a dead task is a number nobody can act on.

**Rung two — the sweeper's verdict on a leg that can never answer** {#deepdives-h-rung-2}

An exhausted screening leg is a conclusion problem, not a retry problem: a two-valued leg leaves an unanswered list no way to finish. So the [sweeper](../patterns/distributed/coordination/sweeper.md) stamps it `unavailable`, the collector waits for every leg to have finished instead of answered, and the leg's criticality in the [configuration store](../patterns/distributed/coordination/external-configuration-store.md) prices the ending. Blocking plus unavailable holds the flow and escalates to a human; on a list a regulator will ask about, late beats wrong. Advisory plus unavailable concludes `cleared_with_caveat`, names the missed list in the client's event and books a re-screen. A fan-in must never read an unanswered check as clean, so the gap rides on the verdict.

**Rung three — leases, and why a crash needs no special case** {#deepdives-h-rung-3}

A worker renews a lease while it works; a crashed worker stops, the lease expires, and the sweeper returns the row to `pending`, the same transition a retry makes, so no code tells a crash from a retry. The schedulers use the same mechanism one level up: the sweeper and both recheck clocks hold [leader-election](../patterns/distributed/coordination/leader-election.md) leases in the coordination cache, because two sweepers double-invite people and two recheck clocks double-spend vendor quota. A dead scheduler's lease expires and a replica takes it.

**Rung four — the vendor controls** {#deepdives-h-rung-4}

Four controls surround each vendor and each answers a different question. A [timeout and deadline](../patterns/distributed/resilience/timeout-deadline.md) puts a line under one call, because no vendor publishes a latency guarantee. A [rate limiter](../patterns/distributed/resilience/rate-limiter.md) holds back calls that would succeed and breach the contract. A [circuit breaker](../patterns/distributed/resilience/circuit-breaker.md) holds back calls that would fail; its state lives in the shared cache, since per-process breakers make N replicas each absorb the outage and then send N probes at a vendor barely back. A [bulkhead](../patterns/distributed/resilience/bulkhead.md) stops one stalled vendor eating the capacity another needs. With the cache unreachable, each worker falls back to a local breaker and a local [token bucket](../patterns/distributed/resilience/token-bucket.md) at its fair share; with the cache back but empty, breakers seed open, because reading an empty cache as healthy is how a fleet stampedes a vendor that never came back.

**Rung five — the fallback that moves itself** {#deepdives-h-rung-5}

Where a step has a second provider, the traffic weights follow numbers the system already collects. The per-vendor error rate that feeds the alarm also feeds a control job that cuts a failing provider's share, decays it back as health returns, and writes the result to the cache so every replica splits identically. An operator can pin a weight through an incident, and the pin beats the automation until released. A split only a deploy can move is a constant with extra steps. Roster and default weights sit in the configuration store, so a fallback vendor costs a configuration change and a translator.

**Rung six — the backlog, because a slow system and a stalled one break the same promise** {#deepdives-h-rung-6}

A queue answers a burst and not sustained overload; it postpones the failure and grows. So admission follows the drain rate: once the live class's oldest pending task passes its ceiling, `POST /flows` answers 429 with a `Retry-After`, which puts [backpressure](../patterns/concurrency/backpressure.md) in the contract instead of an incident review. One layer down, the synchronous standby acknowledges each commit before the client sees a response, so promotion costs no acknowledged fact. An asynchronous [replica](../patterns/distributed/coordination/replication.md) is refused for that reason: the fact it could lose is the append somebody was already promised.

**The stance all of that rests on** {#deepdives-h-recovery-stance}

One writer with a synchronous standby chooses consistency over availability, so a partition ends with creates refused rather than a second flow opened for one person or an append the relay never sees. Read through [PACELC](../themes/cap-theorem.md) it is PC/EC: latency paid in both branches, inconsistency in neither. That is why every clock above is mandatory. An availability-first design absorbs a stall as eventual consistency; here a stall is a fact nobody can see yet, and only a deadline the system owns turns it back into one. The one eventually-consistent surface left is the client's own view, an at-least-once webhook that can lag by minutes.

**What the clocks are set against** {#deepdives-h-clock-baseline}

You can only promise what you own, and the slowest participant here is not owned. What is measured must be queryable: a flow's age in state, a task's age since claimable, undelivered attempts per lane, per-vendor error rate. What is engineered to stays internal and is assumed, not given: 99% of flows leave `awaiting_id_verification` within 4 hours of the vendor accepting them, 99% of screening rounds close within 12 hours of fan-out, 99.9% of client-visible events go out within 5 minutes of their append. What is promised to the client sits looser, or no room is left to operate: an operator paged within 15 minutes of a flow passing its state deadline, a client failure event within 5 minutes of a flow being declared stuck (assumed, not given). The gap between engineered and promised is the error budget, spent on deploys and vendor outages; when it is gone, stop shipping instead of restating the number. Nothing is promised about time-to-verdict, because the two slowest participants are a vendor down 3.6% of the week and a human being.

```mermaid caption="The recovery ladder: silence past a deadline enters the same path as an error, and an exhausted screening leg gets a finished state of its own." wide=true
flowchart TB
    Start["Task claimed · lease + deadline_at"] --> Call["Call vendor"]
    Call -->|"2xx callback"| Done["done — appended, folded"]
    Call -->|"error"| Retry{"attempts < max?"}
    Call -->|"SILENCE past deadline_at"| Retry
    Call -->|"worker dies"| Lease["lease expires"]
    Lease --> Pending["status = pending"]
    Pending --> Call
    Retry -->|"yes"| Backoff["run_after = now + backoff·jitter"]
    Backoff --> Pending
    Retry -->|"no"| Dead["dead_at · last_error · ALERT"]
    Dead --> Leg{"is it a screening leg?"}
    Leg -->|"no"| Ops["operator inbox — re-runnable"]
    Leg -->|"yes"| Un["sweeper stamps verdict = unavailable"]
    Un --> Crit{"criticality"}
    Crit -->|"blocking"| Hold["hold flow · escalate to a human"]
    Crit -->|"advisory"| Caveat["conclude cleared_with_caveat<br>name the gap · schedule a re-screen"]
```

### 4 · Draining a backlog you did not choose → NFR: scale

**The recurring book is a second workload as large as the first, so each class gets reserved capacity, a split quota and a pool that scales on queue age.** It arrives on a legal clock, not a customer's. Replicas compete through [skip-locked claims](../patterns/messaging/competing-consumers.md): the claim locks a pending row and steps over locked ones, so no two workers hold a task and none waits behind another. Sorting the claim by priority is the obvious move and the wrong one, because a [priority queue](../patterns/messaging/priority-queue.md)'s own advice is against strict preemption when the low class has a deadline too, and a jurisdiction's cadence is a deadline. So capacity is reserved per class: live flows hold a floor the batch may not borrow, and the batch holds a floor no busy onboarding day can take.

Quota splits the same way, because two pools drinking from one ceiling are one pool. On a delta day the batch would spend the contracted rate and live legs would wait on `run_after`: [starvation](../hazards/starvation.md) at the quota with every aggregate alarm green, which is why the alarm is per class.

[Batching](../patterns/concurrency/batching.md) keeps the bill survivable. Per-person legs put 5.5 outbound calls a second against a rate contracted for today; 500 persons per call takes the recurring half under a thousand calls a day. It buys rate and not invoice, since the vendor still bills every person-list check. The cost is a coarser failure unit, paid by applying the response one member per transaction against one inbox row per member: a member the vendor could not adjudicate dead-letters its own leg while 499 commit, where a naive batch rolls back 500 results for one malformed record. Live flows are never batched.

Capacity follows queue age, not processor load: a pool blocked on vendor calls reports almost no utilisation while its backlog climbs, so [autoscaling](../patterns/distributed/routing/autoscaling.md) on load would sit still through the incident. Each pool adds replicas once its oldest pending task passes 60 seconds and gives them back after ten minutes below five, with two replicas as the floor and a ceiling set by the vendor's contracted concurrency. Scale-in needs no choreography: a stopping replica finishes or abandons its claim, and an abandoned claim is the expired lease every deploy already rehearses.

Finally the front door is part of the drain. [Queue-based load leveling](../patterns/distributed/resilience/load-leveling.md) absorbs a burst and only postpones sustained overload. [Admission control](../patterns/distributed/resilience/load-shedding.md) refuses a create when the live class's oldest pending task passes its ceiling: refusing costs the client a retry, while accepting costs them a flow invisible for hours behind work they cannot see.

```mermaid caption="Two classes share one task table but not capacity or quota, and the front door closes while the live class is behind." wide=true
flowchart LR
    Live[("task · class = live")] -->|"floor the batch cannot borrow"| PoolL["Live pool"]
    Rech[("task · class = recheck")] -->|"floor busy days cannot take"| PoolR["Recheck pool"]
    PoolL -->|"own quota share, per-person legs"| V["List vendors"]:::ext
    PoolR -->|"own quota share, 500 per call"| V
    Auto["Autoscaler · oldest-pending age"] -.-> PoolL
    Auto -.-> PoolR
    Adm["Admission control"] -.->|"429 when live age passes ceiling"| In["POST /flows"]
    classDef ext stroke-dasharray:4 4;
```

### 5 · What you watch, and why there is no tap → NFR: observability

**The record is the trace, so observability costs one correlation id, a short alarm set and SQL, not a second copy of the traffic.** One [correlation id](../patterns/messaging/correlation-identifier.md), the flow id, runs through every append, task, vendor call and delivery attempt, so "why is this flow stuck" is a query. At ~75 flows a day behind one database, [distributed tracing](../patterns/distributed/resilience/distributed-tracing.md) would instrument a call graph three hops deep; that stops being true the day the deferred broker arrives and work leaves the transaction.

A [wire tap](../patterns/messaging/wire-tap.md) is turned down, and not on cost. The log is already a complete, ordered, queryable copy of every fact, so a tap buys only a second surface carrying personal data, and monitoring surfaces are where access control is weakest. The one job that would earn a tap is shadow-testing a new list vendor on live traffic, a future need with a name.

Log lines carry ids and nothing else, since the vault is the one place raw personal data exists and a [log line may not become a second copy of it](../patterns/security/secure-logger.md). Each alarm ships its runbook in the same definition, not in a wiki beside it. Warn means a human looks in working hours; page means someone is woken. Every threshold traces to a deadline or service level stated above, so moving one means re-arguing the number it protects.

| Metric | Why it is tracked | Alert threshold |
| --- | --- | --- |
| Oldest pending task age, live class | The aggregate stays green while one class starves; also the autoscaling signal and the admission-control input | warn 5 min; scale out on trend; page 15 min, the ceiling that turns `POST /flows` into 429 |
| Oldest pending task age, recheck class | A jurisdiction's cadence missed quietly is a compliance breach | warn 4 h; page 12 h |
| Flows past `state_due_at` | The 15-minute paging SLA is defined against exactly this predicate | any > 0 → page within 15 min |
| Dead tasks (`dead_at` set) | A parked task is work the system gave up on; only a human recovers it | any > 0 → page, always |
| Delivery lanes in backoff, by tenant | Grouped so one broken endpoint reads as one problem, not thirty | warn ≥ 3 lanes of one tenant for 15 min; page any lane older than 12 h (it dies at ~24 h) |
| Dead delivery lanes | A client is missing verdicts right now | any > 0 → page; runbook ends at `/events/replay` |
| Per-vendor error rate | One series feeds the alert, the breaker and the fallback weights; divergence between them is itself a bug | warn 5% over 5 min (weights begin to shift); page 25% sustained 15 min or breaker open > 30 min |
| Outbound legs/s vs contracted ceiling | Fires months before anything breaks; the invoice is the binding constraint | warn 70% sustained 1 h; page 90% |
| Age of oldest undelivered client-visible event | The delivery guarantee as one number: 99.9% within 5 min of append | warn 5 min; page 15 min |
| Inbox collisions per vendor per hour | Turns a vendor's retry storm into a fact instead of a mystery in the latency graph | warn at 10× the hourly baseline |
| Standby acknowledgement | Without it a primary loss loses acknowledged facts | standby down or not acknowledging → page immediately; writes are already stalling by design |
| Monthly vendor quota consumed | The recurring book compounds against a contract signed for today's volume | warn at 80% of the monthly cap with days left in the month |

{#deepdives-metrics-table}

### 6 · Evidence, erasure and the three clocks → NFR: compliance

**Three clocks pull on one person's data, so each gets its own mechanism and the design says which wins: retention outranks erasure, and erasure is key destruction.** An invitation expires in hours, a security control. Retention runs in years from the end of the relationship, a legal duty. An erasure request arrives when the data subject decides. Folded into one cleanup job, they eventually destroy evidence the system had to keep or keep data it had to destroy.

Retention counts from `closed_at`, which is why an [object store](../patterns/distributed/routing/object-storage.md)'s lifecycle rule cannot be the policy: lifecycle rules expire by object age, so one drops a photo five years after upload while the duty runs five years after the merchant stopped trading with that person, a decade apart in places. So `retain_until` is computed at close against the jurisdiction's schedule, a retention sweep enforces it on the due-dated machinery the recheck clocks use, and the bucket rule stays a backstop for blobs nothing references.

Erasure is key destruction, because a delete is a claim and a destroyed key is a proof. Each person's data is sealed under its own envelope key, so destroying it makes every copy unreadable in one act, backups included, which no delete reaches without restoring and rewriting them. The photo is retired the same way. `flow.email_mac` is an HMAC under a per-region key that erasure also destroys: email addresses are low-entropy and enumerable, so a plain digest would let anyone holding the database recover which named people were screened, for which client, to which verdict.

While a retention obligation is live it outranks erasure, and the request is queued rather than refused. The delete answers 409 with the date the duty lapses and books the destruction for that day, giving the client a date to hand their data subject. `flow_event` and `audit_log` survive because they reference only `person_ref`; destroying the papertrail with the person would destroy the only proof the erasure happened.

```mermaid caption="An erasure request meets a live retention duty: queued with a date, then executed by destroying the key; the history survives." wide=true
flowchart LR
    Req["DELETE /persons/{ref}"]:::ext --> Q{"retain_until in the future?"}
    Q -->|"yes"| Held["409 + date · destruction booked for that day"]
    Q -->|"no"| Kill["destroy envelope key + email_mac key"]
    Held -->|"duty lapses"| Kill
    Kill --> Noise["vault blob and backups unreadable"]
    Kill -.->|"survives by design"| Keep[("flow_event · audit_log — person_ref only")]
    classDef ext stroke-dasharray:4 4;
```

### 7 · Tenancy the database enforces → NFR: security & tenancy

**The refusal belongs in the database, where one forgotten predicate in an application filter cannot become a reportable incident.** The policy applies to every code path that ever issues the read. It is only as wide as the column it binds to, so `client_id` sits on every client-scoped table; a history table without it is one the policy cannot reach, and appended events give away verdicts and timestamps as readily as a name gives away a person.

Three details decide whether the policy holds. Row-level security alone is bypassed by the table's owner, so the application connects as a non-owner role and the tables carry `FORCE ROW LEVEL SECURITY`. The tenant is set with `SET LOCAL`, never plain `SET`, so the value dies with its transaction instead of riding a pooled connection into the next tenant's checkout. And the cross-tenant parts of the fleet (worker pools, sweeper, relay) cannot run under the policy, so they run as a separate principal with its own credentials and audit and no path to the dashboard. The relay reads client-visible events for every tenant, making it the widest principal on the board; the exemption is written down here, not discovered in an incident.

The onboardee has no account and should never want one. Their identity is possession of a [single-use link](../patterns/security/secure-session-manager.md): 256 random bits, kept only as a hash, dead after 48 hours, revoked when a resend supersedes it, and spent when the document lands. Redeeming it is a [conditional write judged by rowcount](../patterns/distributed/coordination/conditional-write.md), so two simultaneous redemptions cannot both succeed and the failure tells expired from forged from spent. It authorises one flow's submission and nothing a client owns.

Residency is a whole [stack per region](../patterns/distributed/routing/deployment-stamp.md), not a column. Gateway, API, workers, relay, schedulers, Postgres and standby, vault, key manager, object store and cache come from the same infrastructure code, and only jurisdiction configuration differs. No region shares data with another, so a query cannot cross a boundary it has no connection across. N stamps multiply cost, operational surface and configuration drift, and losing a region is that region's downtime by choice.

```mermaid caption="Which principals run under the tenant policy, and which are the audited exceptions." wide=true
flowchart TB
    Dash["Dashboard session"]:::ext -->|"SET LOCAL app.client_id"| RLS["Tables under FORCE RLS<br>non-owner role"]
    Link["Onboardee — single-use link"]:::ext -->|"one flow's submission only"| API["Identification API"]
    API --> RLS
    Fleet["Workers · sweeper · relay<br>separate audited principal"] -->|"claims across tenants"| RLS
```

### 8 · What changes without a rewrite → NFR: evolvability

**Everything added later hangs off the log the mandatory product already writes, so additions attach without a second write path.** The twelve mandatory requirements alone are a complete, correct product. Re-screening, re-verification, relationship close, replay and the access papertrail all read from or append to `flow_event`, and none asked for a write path of its own, which is the difference between an addition and a second system. A new jurisdiction is a cadence and a list set in configuration; a new sanction list is a row in that set plus a task kind the pool already runs.

A new vendor should cost a translator and nothing else. Six foreign models reach this system (the identity provider, four list vendors, the email sender), each with its own word for a match and for a failed check. Admitted unnormalised, the adjudication rule ends up written in six dialects and any vendor's contract change edits our business logic. So each provider sits behind an [anti-corruption layer](../patterns/ddd/acl.md) that maps the payload onto our three verdicts and stamps `provider` and `policy_version` onto the appended event, which lets the log answer years later by what policy and which provider a person was checked. Where the parsing happens is load-bearing. Inside the transaction, a payload the parser rejects rolls the inbox row back: the system holds no evidence of the callback, the vendor retries forever, and the dead-letter write dies in the same rollback. Ahead of `BEGIN`, one transaction commits the inbox row, a dead-letter row and an escalation together, and the vendor stops retrying.

The schema evolves reader-first: a new event type or task kind reaches the workers that understand it before the writer that emits it, and a projection whose shape changed is rebuilt from the log rather than migrated. The bill is `payload`, an untyped contract with four consumers carried on discipline where a schema registry would otherwise carry it.

Every exit is additive and waits on a number. The partial indexes over claimable tasks and publishable events are already in place. After that: stagger recheck cadences across the quarter once the delta-day spike shows in per-class age; partition the log by time past ~500 GB, which the relay survives because its predicate is per flow; add a read replica once dashboard and audit-export reads compete with worker claims; adopt a broker at roughly sustained 100k flows a day, when the relay's cursor becomes a consumer group and ordering becomes a partition key; and take a [workflow engine](../patterns/distributed/coordination/workflow-orchestration.md) only if flow variants multiply, at the price of handing an append-only history to the engine's own.

```mermaid caption="Where the translator runs decides whether a bad payload is a recorded dead letter or an endless vendor retry."
flowchart LR
    subgraph Rejected["Rejected — parse inside the transaction"]
        P1["BEGIN"] --> P2["inbox row"] --> P3["parse fails"] --> P4["ROLLBACK — no trace, vendor retries forever"]
    end
    subgraph Adopted["Adopted — translator ahead of BEGIN"]
        T1["parse + stamp provider, policy_version"] --> T2["BEGIN"] --> T3["inbox + dead-letter row + escalation"] --> T4["COMMIT — vendor stops retrying"]
    end
```

### 9 · A clean check, end to end

**A walkthrough, not new machinery: dives 1, 2 and 3 in time order.** A successful check is a chain of small transactions with rows waiting between them. Watch three things: every ingress writes an inbox row first, every wait is a task with a deadline, and every client-visible append is a delivery the cursor owes until a 2xx arrives.

```mermaid caption="One successful check in time. The link is spent when the document lands, not when the form posts, and the conclusion is appended by whichever leg finds its round empty." wide=true
sequenceDiagram
    autonumber
    participant C as Client
    participant API as API
    participant PG as Postgres
    participant P as Person
    participant V as Vendors
    participant R as Relay
    C->>API: POST /flows
    API->>PG: inbox('create') · append flow_created · task send_invite
    API->>C: 202 { flowId, seq 1 }
    PG->>V: (worker) send invite — key from task id
    V->>P: email with 48h single-use link
    Note over P: waits ~24h — a row, not a connection
    P->>API: POST /submissions (magic link, still unspent)
    API->>PG: append submission_received · document row
    P->>V: PUT photo direct to object store
    API->>PG: append document_stored · SPEND the link · task verify_id
    PG->>V: (worker) verify — lease 60s, deadline 24h
    V->>API: callback idv pass
    API->>PG: inbox('idv') · append idv_passed · fan out 4 screen tasks
    PG->>V: (workers) screen ofac, un, eu, uk — round 4
    V->>API: 4 callbacks, each with its own requestId
    API->>PG: 4 × inbox · 4 × list_reported · last one appends screening_concluded
    R->>PG: claim lane — delivered_seq 0, owed seq 11
    R->>C: webhook { eventId, seq 11, verdict clear }
    C->>R: 200
    R->>PG: delivered_seq = 11
```

### 10 · The vendor dies mid-check

**A walkthrough, not new machinery: dive 3's ladder under a dead provider, ending on dive 2's lane.** A dead provider costs latency, never a fact. Four decisions are made by data, not a person: the breaker opens because the shared error rate says so, the fallback is chosen by the weights in the cache, the leg ends because a deadline says so, and what that ending costs comes from a criticality in configuration. Nobody is woken until the last step, and the flow's business state does not move while the stall lasts.

```mermaid caption="How a check finishes when its provider dies. Vendor A returns errors, which a breaker can see; vendor B accepts and goes quiet, which only a deadline can." wide=true
sequenceDiagram
    autonumber
    participant W as Screening worker
    participant Ca as Coordination cache
    participant V1 as List vendor A
    participant V2 as List vendor B (fallback)
    participant S as Sweeper
    participant PG as Postgres
    participant C as Client
    W->>Ca: read breaker + weights for 'ofac'
    W->>V1: screen (round 4) — deadline 4h
    V1--xW: 503
    W->>PG: attempts=1 · last_error · run_after = +2s·jitter
    W->>Ca: error rate up — breaker OPENS for vendor A
    Note over Ca: every replica sees it — one outage absorbed once
    W->>Ca: weights shifted toward vendor B
    W->>V2: screen (round 4) — same round, same leg
    V2--xW: accepts, then SILENCE
    S->>PG: leg past deadline_at — no event to react to
    S->>PG: attempts exhausted → verdict = 'unavailable'
    S->>PG: read criticality from configuration
    alt blocking list
        S->>PG: hold flow · append flow_stuck · page an operator
        PG->>C: failure event via the relay lane
    else advisory list
        S->>PG: append screening_concluded — cleared_with_caveat
        S->>PG: schedule a re-screen for the list's return
        PG->>C: verdict + the named gap, same lane, same contract
    end
```

### 11 · Recheck day — the batch, and the debt it creates and repays

**A walkthrough, not new machinery: dives 4, 2 and 3 on the heaviest day of the quarter.** Recheck load grows with the book, not with intake, and behaves like debt: rows owed, worked off through the paths a live check uses. The clock re-enters each due flow with a `screening_started` append that opens a new round, batch calls carry roughly 500 persons, each member's result takes its own inbox row in its own transaction, and a changed verdict leaves down the same lane. Three queues hold the debt and all read empty at day's end: pending recheck tasks, unmatched inbox rows, and cursors still owing events. Shape keeps the day in its window: reserved capacity, a split quota, admission control and autoscaling on oldest-pending age.

```mermaid caption="Where the recheck backlog lives while it works. A member's failure is its own, and the front door closes while the class is behind."
flowchart LR
    Clock["Recheck clock · leased"] -->|"rescreen_due_at < now"| Rounds[("screening_started<br>new round per flow")]
    Rounds --> Tasks[("task · class = recheck")]
    Tasks -->|"500 persons per call<br>reserved quota share"| V["List vendors"]:::ext
    V -->|"batch callback"| IB[("inbox — ONE ROW PER MEMBER")]
    IB -->|"one txn per member"| Log[("flow_event")]
    IB -.->|"member the vendor could not adjudicate"| DL["dead leg — the other 499 commit"]
    Log --> Cur[("delivery_cursor — owed events")]
    Cur --> C["Client"]:::ext
    Adm["Admission control"] -.->|"429 while the class is behind"| C
    Auto["Autoscaler · oldest-pending age"] -.-> Tasks
    classDef ext stroke-dasharray:4 4;
```

### 12 · Follow-up questions this design must answer

Three questions that probe where a guarantees-first design usually breaks. Verdict first.

**Q1 — You claim exactly-once. Prove it, or withdraw the claim.** Withdrawn as stated: the claim is at-least-once transport with an idempotent effect at four boundaries, which is exactly-once in effect wherever the system owns both ends. The webhook's effect sits in the client's code, so the contract names the client's two obligations ([the fifth boundary](#deepdives-h-boundary-5)).

**Q2 — A relay that reads the system of record on its hot path sounds like a liability. Why is it not?** Because it has one capability: read a predicate, write a cursor. It cannot append, fold or decide what is publishable.

```sql summary="the relay's whole surface"
-- READ: one indexed lookup per owed lane. No scan, no join to the projection.
SELECT e.event_id, e.seq, e.type, e.payload
  FROM delivery_cursor c
  JOIN flow_event e ON e.flow_id = c.flow_id
                   AND e.seq > c.delivered_seq
                   AND e.client_visible
 WHERE c.flow_id = $claimed_flow
 ORDER BY e.seq LIMIT 1;

-- WRITE: this row and nothing else, ever.
UPDATE delivery_cursor SET delivered_seq = $seq, attempts = 0 WHERE flow_id = $flow;
-- The relay's principal has SELECT on flow_event and UPDATE on delivery_cursor, so "the relay
-- corrupted the audit record" is a permission that does not exist.
```

**Q3 — Every guarantee here is a race. How do you prove the guards hold?** By staging each race as two open transactions: the guards are SQL, so a race is two sessions and a held lock, repeatable on every build instead of at a quarterly game day.

```text summary="the race rota"
append collision   two sessions read the same last_seq and both insert at seq+1
                   → exactly one commits; the loser's fold AND tasks go with it
duplicate first    deliver one callback twice, second copy committing first
                   → the inbox constraint aborts one whichever order they arrive
batch redelivery   replay a 500-member batch whose first 300 already applied
                   → 200 new rows, 300 constraint violations, zero double-applies
zombie worker      claim a task, expire its lease by hand, let a competitor advance the
                   flow, then let the original append → it collides, never double-applies
collector          report the last two legs of a round in concurrent transactions
                   → exactly one may append screening_concluded
lane ordering      hold one flow's lane in backoff and assert the seq behind it never
                   leaves first, and that replay re-emits the same ids in the same order
sweeper vs worker  let a lease expire while the worker is mid-call
                   → the re-claim and the late callback converge on one applied effect
failover           promote the standby with commits in flight
                   → every acknowledged append survives; no delivered_seq goes backwards
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The worst flaw, named first: the last boundary of the delivery contract sits in somebody else's code.** This system can make a repeat recognisable and only the client's handler can make it harmless, so a client that ignores `eventId` pays twice while every promise on this page is kept.

### What it buys
<!--meta polarity=pro-->

- **Nothing can diverge.** The ingress record, the state change, the evidence and the client's event are one commit, so no window exists in which one is present without the others. This holds inside the operational store; the personal-data store and the client's own handler sit outside that one commit.
- **Every duplicate has an owner.** Four boundaries carry four keys, each issued by the side that can see both copies, so a repeat collides instead of being absorbed by luck.
- **Order is a property.** Sequence is total within a flow and the relay walks one lane at a time, so a stale verdict has no route past a fresh one.
- **Nothing stalls unnoticed.** Every in-flight state and vendor leg carries a deadline the sweeper enforces, so a silent vendor is a breach with a page attached.
- An expired lease and an exhausted retry both return a row to pending, so a dead worker, a dead scheduler and a rolling deploy are one code path.
- Replay is one cursor write, because the events are still in the record.
- Closing a relationship nulls both clocks, which bounds the recurring book and the vendor bill with it.

### What it gives up
<!--meta polarity=con-->

- **The contract is only as exactly-once as the client's dedup.** Four counter-moves cut their exposure and none is a guarantee, because the effect lands in code this system never sees (see dive 2).
- **The record is four contracts in one untyped column.** `payload` serves the projection, dashboard, auditor and webhook at once, so a schema mistake hits all four and nothing in the build checks it (see dive 8).
- **Per-flow lanes serialize a hot flow.** A failing client endpoint delays that flow's later verdicts for up to a day before the lane dies (see dive 2).
- **Postgres is the single writer and single point of failure.** An outage stalls every write until the standby is promoted (see dive 3).
- The recurring book outgrows the contract before it outgrows the database, because vendor legs compound with open relationships while revenue follows new ones (see Right-sizing).
- Each region is an island with one vault, so N stamps multiply cost and configuration drift, and a regional outage is that region's downtime (see dives 6 and 7).
- The record only grows, and its exit is a partition rather than a delete, because the evidence is what makes it large.

## What's expected at each level
<!--meta block=levels-->

### Mid-level {#levels-h-mid}

- Names the four places a duplicate can enter before designing a guard for any of them.
- Asks for the volume first and holds the design to it: ~75 person-flows a day, taken out to 10k.
- Puts a durable state model and a task queue between the system and the vendor calls, because a wait is a row and not a held connection.
- Walks the failure paths when prompted: vendor down, worker dead mid-task, retries spent, link expired, upload failed.

### Senior {#levels-h-senior}

- Argues the log as the outbox against a separate outbox table instead of reciting either (dive 1).
- Separates deduplication from ordering and gives each its own mechanism, a stable `eventId` and a lane per flow (dive 2).
- Prices the lane as head-of-line blocking, bounded by its attempt budget and per tenant by construction.
- Separates operational state from business state without being asked, so attempts and leases never reach the log.
- Puts tenant isolation in the database through forced row-level security on every `client_id` table (dive 7).

### Staff+ {#levels-h-staff}

- Treats recovery as one checkable invariant, that nothing stalls without a clock, and follows it to the `unavailable` leg outcome (dive 3).
- Takes a CAP position, consistency by one writer and a synchronous standby, and prices it in indicators, objectives and a looser client promise.
- Prices the deferred broker, workflow engine and log partitioning against the triggers set in Right-sizing.
- Defends the client-side last boundary as the design's biggest flaw, chosen deliberately, and states the four counter-moves.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Alternative to**

- [Persona Identification & Sanction Check](./persona-identification.md) — the same brief on a mutable flow row plus a history table and an outbox — read it when there is no event-sourcing budget and an auditor must read business state without tooling

**The record and its guards**

- [Event Sourcing](../patterns/architecture/event-sourcing.md) — one append carries the state change, the auditor's evidence and the client's event, and the relay publishes from that same row
- [Materialized View](../patterns/distributed/coordination/materialized-view.md) — current state is folded in the same transaction as the append, so it never lags the record and can be rebuilt from it when its shape changes
- [Optimistic Concurrency Control](../patterns/distributed/coordination/optimistic-concurrency-control.md) — the (flow_id, seq) primary key is the guard: a zombie worker whose lease expired collides on the sequence it aimed at instead of double-applying
- [Pessimistic Locking](../patterns/distributed/coordination/pessimistic-locking.md) — the claim takes a skip-locked row lock because contention on pending work is the normal case, and the lock dies with its transaction
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — the magic link is redeemed by an UPDATE carrying its whole precondition, judged by rowcount, so two concurrent redemptions cannot both win

**Delivery and idempotency**

- [Outbox](../patterns/distributed/coordination/outbox.md) — the log is the outbox: the state change and the published event are one append, so the relay reads the record and there is no second table to keep honest
- [Inbox](../patterns/distributed/coordination/inbox.md) — every ingress writes a row keyed on the sender's own id in the same transaction as its effect — a client create, a vendor callback, and one member of a 500-person batch
- [Idempotency](../patterns/messaging/idempotency.md) — four boundaries, four keys, each issued by the side that can see both copies — and the fifth boundary, the client's own handler, named as outside the system
- [Sequential Convoy](../patterns/messaging/sequential-convoy.md) — the relay claims a flow rather than an event and sends one sequence at a time, so a stale clear cannot overtake a sanctioned hit

**Flow progression and fan-in**

- [Saga](../patterns/distributed/coordination/saga.md) — verify, screen and notify are local transactions sequenced by appends, with explicit failure states instead of a transaction manager spanning the vendors
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — an append-only record plus a task table is a hand-rolled durable orchestrator: a crash or a deploy resumes mid-flow rather than restarting it
- [Scatter-Gather](../patterns/messaging/scatter-gather.md) — screening fans one leg per list and only the leg that finds none outstanding within its own round concludes the flow

**Queue, workers and recovery**

- [Competing Consumers](../patterns/messaging/competing-consumers.md) — stateless replicas claim tasks with a skip-locked read, so two never take the same row and capacity is a replica count
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — a task carries attempts, max_attempts and last_error, so a poison message is parked with its diagnosis rather than retried forever
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — the task table absorbs onboarding bursts and six-hour vendor outages ahead of fixed vendor rate limits
- [Priority Queue](../patterns/messaging/priority-queue.md) — live flows and the recurring recheck batch share one table but claim from separately sized pools, because the batch's cadence is a legal deadline too
- [Batching](../patterns/concurrency/batching.md) — the recurring book screens 500 persons per vendor call, with one inbox row and one transaction per member so the batch is transport and never a unit of failure
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — pools scale on the age of their oldest pending task, never on processor load, because workers sit blocked on vendor calls with utilisation near zero
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — no worker, relay or scheduler holds state, so a lost claim is an expired lease and a rolling deploy needs no drain choreography
- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — replicas report readiness so the scaler and the deploy know which instance may take work and which is draining a claim
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — one leased job expires stale leases, dead-letters exhausted tasks, stamps unreachable screening legs, expires overdue flows and enforces the retention clock
- [Leader Election](../patterns/distributed/coordination/leader-election.md) — the sweeper and both recheck clocks hold leases, because two sweepers double-invite people and two recheck clocks double-spend vendor quota

**Vendor boundary and resilience**

- [Anti-Corruption Layer](../patterns/ddd/acl.md) — one translator per vendor maps six foreign vocabularies onto our three verdicts and stamps provider and policy_version onto the append
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — one breaker per vendor in the shared cache, seeded open after a cache restart so an empty cache never reads as all-healthy
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — vendor calls and deliveries retry on a growing schedule with jitter recorded on run_after, because a cohort that failed together would otherwise return together
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — every state, task and screening leg carries a deadline, because a vendor that accepts a call and goes silent produces no event for anything else to react to
- [Bulkhead](../patterns/distributed/resilience/bulkhead.md) — one pool per vendor, and a second split by workload class so the recurring compliance sweep cannot starve a person waiting on an invite
- [Replication](../patterns/distributed/coordination/replication.md) — a synchronous in-region standby acknowledges every commit before the client does, so promotion loses no acknowledged fact
- [External Configuration Store](../patterns/distributed/coordination/external-configuration-store.md) — the list roster, per-list criticality, recheck cadences, vendor quotas and provider weights move without a deploy, and a worker boots from its last cached version

**Edge, admission and tenancy**

- [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) — one public edge terminates transport layer security (TLS), authenticates the tenant and enforces both the rate limit and the admission ceiling before anything reaches the application programming interface (API)
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — an inbound per-client limit at the edge, and an outbound per-vendor quota split by workload class so the recurring batch cannot spend the live class's share
- [Backpressure](../patterns/concurrency/backpressure.md) — when a class's oldest pending task passes its ceiling the create returns 429 with a Retry-After, because a queue alone only postpones sustained overload
- [Load Shedding](../patterns/distributed/resilience/load-shedding.md) — the create returns 429 with a Retry-After when the live class's oldest pending task passes its ceiling, because accepting a flow into a backlog it cannot drain hides the failure rather than fixing it
- [Secure Session Manager](../patterns/security/secure-session-manager.md) — the onboardee has no account: their session is a hashed single-use link, spent when the document lands rather than when the form posts
- [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md) — residency is one full stack per region — edge, application programming interface (API), workers, relay, Postgres and standby, vault, key manager, object store — stamped from the same code with only jurisdiction config varying

**Payloads, evidence and restraint**

- [Object Storage](../patterns/distributed/routing/object-storage.md) — identity photos go straight to an object store on a presigned upload, referenced by key from a metadata row written before the URL is signed
- [Valet Key](../patterns/distributed/routing/valet-key.md) — the photo goes up on a URL scoped to one object for fifteen minutes, re-issuable when a mobile upload fails, so the application programming interface (API) decides who may upload and then leaves the data path
- [Claim Check](../patterns/messaging/claim-check.md) — workers pass the photo's storage key between steps, never the image bytes
- [Correlation Identifier](../patterns/messaging/correlation-identifier.md) — one flow id threads every append, inbox row, task, vendor call and delivery attempt, so a stuck flow is one query rather than an archaeology exercise
- [Keep It Simple (KISS)](../principles/kiss.md) — one Postgres and stateless workers carry the whole delivery guarantee; every rejected broker, router, tap and polling application programming interface (API) is priced against a confirmed hundred onboardings a week
- [Secure Logger](../patterns/security/secure-logger.md) — log lines carry flow and person ids only, so a log never becomes a second copy of the vault

**Exposed to**

- [Head-of-Line Blocking](../hazards/head-of-line-blocking.md) — the per-flow ordered lane holds a flow's later events behind one failing delivery; the attempt budget kills the lane after about a day and a stale verdict never overtakes a newer one
- [Thundering Herd](../hazards/thundering-herd.md) — a six-hour vendor outage ends and every parked flow comes due at once; jitter on run_after and a shared breaker probe keep the cohort from returning together
- [Starvation](../hazards/starvation.md) — a recurring recheck batch on a delta day would spend the vendor quota and starve live invites; separate pools and quotas bound it

**Demonstrates**

- [Token Bucket](../patterns/distributed/resilience/token-bucket.md) — With the shared cache unreachable, each worker falls back to a local token bucket sized to its fair share

<!-- relationships:end -->
