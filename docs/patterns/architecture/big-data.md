---
title: Big Data
description: "Two paths over the same data: batch for accuracy, stream for now"
area: architecture
owner: Oleksandr Derechei
tags: [scalability, throughput, batching, transformation]
status: stable
aliases: [lambda architecture, kappa architecture, data lake architecture]
solves: [the nightly report now takes longer than the night, our database cannot hold another year of clickstream and the queries have stopped returning, "we find out about a bad reading the next morning, from a report", most of what we collect is logs and JSON that will not fit a table, analysts running queries against production keep slowing down the application]
---

# Big Data

Lands raw data in a distributed file store, then runs a scheduled batch path over the history and a continuous stream path over what just arrived — both feeding stores that answer questions a single database can no longer hold or serve.

## What it is
<!--meta block=description-->

One store cannot both absorb every log line and click cheaply and answer an analyst in a second. Keep every raw record as a file in cheap shared storage, and decide what it means later. A batch job re-reads the whole history for exact totals, and a stream processor answers about the last few minutes. Both write into stores shaped for querying.

## Explained
<!--meta block=explain-->

Big data keeps every raw record as a file in cheap shared storage and works out what it means later, using engines that run on many machines, each reading its own slice. A batch path re-reads the whole history to get exact totals, and a stream path answers about the last few minutes from events as they arrive. Choose it over one database with a read replica (a copy used only for reports) when volume and variety have outgrown the database.

- **Two paths drift apart.** Both hold the same rule; build them from one definition and compare on a schedule, or replay a retained log instead.
- **Wrong partition column.** Every query reads the whole lake, so partition by what queries filter on and check bytes scanned.
- **Tiny files.** Millions of small files slow every read, so merge them in a compaction step.
- **Retries double-count.** A job that appends on retry counts data twice, so have each run overwrite its own partition.

**Example.** A site logs 2 TB of clicks a day and keeps 90 days, so 180 TB. Partitioned by date, a query for one day reads 2 TB. Partitioned by user ID, the same query reads all 180 TB, 90 times more, and nothing reports an error. Writing 1 MB files makes 2,000,000 files a day; merging them into 256 MB files leaves about 7,800. A retry that appends instead of overwriting the day's partition leaves 4 TB for that day, so every total for it is doubled. The cost of the fixes is a compaction job to run and watch.

## How it works
<!--meta block=structure-->

```mermaid caption="Why two paths rather than one? Both read the same arriving data, but the stream path answers about the last few minutes and the batch path recomputes the history correctly on a schedule — so the serving store can hold a fast answer and a right answer at once."
flowchart LR
    Src["Sources — apps, files, devices"]
    Ing[("Ingest buffer")]
    Lake[("Data lake — raw files")]
    subgraph Two["Two paths over the same data"]
        Batch["Batch processing"]
        Stream["Stream processing"]
    end
    Serve[("Analytical store")]
    BI["Reports, notebooks, alerts"]
    Src -->|"1 land raw files"| Lake
    Src -->|"2 publish events"| Ing
    Ing -->|"3 archive a copy"| Lake
    Lake -->|"4 scheduled recompute"| Batch
    Ing -->|"5 transform in flight"| Stream
    Batch -->|"6 accurate views"| Serve
    Stream -->|"7 recent views"| Serve
    Serve -->|"8 query"| BI
```

```mermaid caption="The stream path is allowed to be wrong. A late event misses its window and the fast view under-counts; the batch path reads the archived copy and replaces the number on its next run, which is the reason the batch path is not redundant."
sequenceDiagram
    autonumber
    participant D as Source
    participant I as Ingest buffer
    participant S as Stream job
    participant L as Lake
    participant B as Batch job
    participant Q as Serving store
    D->>I: event timestamped 09:59, arrives 10:07
    I->>S: deliver
    alt still inside the window
        S->>Q: update the recent view
    else window already closed
        S--xQ: the stream path drops it
        Note over L,B: the archived copy is still in the lake
        L->>B: nightly recompute over the whole day
        B->>Q: overwrite the view with the correct total
    end
```

## Variations
<!--meta block=variations-->

- **Lambda: two engines, one answer** — A batch layer holds the immutable master data and recomputes exact views slowly; a speed layer computes approximate views over recent data; a serving layer merges them at query time. You get a fast answer now and an exact one after each batch run, at the cost of two implementations.
- **Kappa: one path, replayed** — Delete the batch layer and treat everything as a stream. Reprocessing means replaying the retained log from the start with new code, so there is one implementation to keep correct — provided the log is long enough and the engine catches up fast enough.
- **Refinement tiers in the lake** — Keep the raw arrivals, a cleaned and conformed copy, and a business-ready copy as three zones rather than transforming in one leap. Each tier is reproducible from the one before it, so a logic bug costs a rerun rather than a re-ingestion.
- **Load first, transform in place** — Land the files untouched and project a schema when someone reads them, rather than validating and reshaping on the way in. Ingestion stops being the bottleneck and stops rejecting data whose shape changed, at the cost of every reader having to cope with what is actually there.
- **Move the work to the data** — Split the dataset into partitions and run the same computation on each node against the partition it is assigned, held locally or read from shared storage, then combine — [MapReduce](../distributed/coordination/mapreduce.md) and every engine descended from it. It is what makes a full-history recompute finish at all, and it only works if the files are splittable.
- **Precomputed serving views** — Publish the answers rather than the data by writing a [Materialized View](../distributed/coordination/materialized-view.md) per question the dashboard asks. Query cost drops to a lookup, and every new question needs a new pipeline.
- **Device telemetry as a specialization** — Connected-device systems are this style with the streaming half enlarged. A gateway at the boundary accepts device events over a low-latency protocol; a field gateway near the devices can filter, aggregate or translate before forwarding, which cuts the volume that ever leaves the site. Add a registry of provisioned devices, a provisioning interface, and a path for command messages back to the device.
- **Ingestion through one pipeline** — Give the recurring movement its own owner: a scheduled workflow that reads the sources, transforms, loads the analytical store and refreshes what the dashboard reads — see [Workflow Orchestration](../distributed/coordination/workflow-orchestration.md). The alternative is every application writing into the lake on its own schedule, which costs you the ability to say what landed, when, or whether it landed at all.
- **A modelling layer over the lake** — Put a semantic model — an OLAP (online analytical processing) cube or a tabular model — between the analytical store and the people querying it, so measures and hierarchies are defined once instead of worked out again in every report. Analysts then self-serve without writing the join, and notebook users still reach past it to the raw files when the model does not have what they need.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Work is split across nodes** that each read their own partition, so volumes no single machine could hold finish in a usable time.
- **Storage and compute scale separately** — keep years of raw files cheaply, and pay for processing only while a job runs.
- **Data lands before anyone agrees on its schema**, so a source whose shape changes stops being an ingestion outage.
- **The same stored bytes serve reporting**, exploration and model training, instead of each team keeping its own copy.
- **Anomalies can be acted** on while the event is still in flight rather than found in tomorrow's report.

### Cons
<!--meta polarity=con-->

- **The tooling is a specialization**. The engines, languages and failure modes differ enough from application development that a team cannot absorb them alongside their normal work.
- **Concentrating every dataset in one store** makes access control the hard problem, because one grant now exposes far more than the source system ever did.
- **Answers are not current**. A batch view is as old as its schedule, and users have to be told which number they are looking at.
- **Two paths mean the same business rule** is implemented twice in two engines, and the two drift silently until someone compares them.
- **Schema-on-read moves the cost** rather than removing it: every reader now handles missing fields, changed types and mixed vintages of the same file.
- **Cost is driven by choices** with no obvious feedback. Partition on the wrong column or land millions of small files, and queries read orders of magnitude more than they need while nothing reports an error.
- **Nothing in the style forces** ingestion through one path, so applications write into the lake directly until no one can say where a dataset came from or when it last changed. The pipeline that fixes it is another system to schedule, monitor and back-fill.
- **Fields scrubbed before landing** cannot be recovered from the raw zone, so choose which to tokenise and which to keep.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The volume or the shape** has outgrown a database — clickstream, logs, telemetry, documents, images.
- **You need to act** on data as it is generated, not after the next reporting run.
- **Analysts and models need the raw history**, not the operational store's current row.
- **Several teams want different views** of the same arriving data and are each about to build their own copy of it.

### Avoid when
<!--meta polarity=avoid-->

- **The data fits comfortably in one database** and the reports finish in time. A read replica or a nightly summary table costs a fraction of this.
- **Nobody on the team** has run a distributed processing engine before and there is no time to learn one.
- **Every question needs the exact current value**. Answers that arrive late are the whole premise here.
- **The problem is compute-bound rather than data-bound** — thousands of cores against a small input is [Big Compute](./big-compute.md), and it is a different shape.

Answers the [Busy Database](../../hazards/busy-database.md) smell: an operational database turned into a warehouse, where one analyst query can take checkout down.

## Code sketch
<!--meta block=sketch-->

```python summary="Python — the same total, computed twice"
# SPEED PATH — one event at a time, approximate, always current.
def on_event(event, recent, alerts):
    day = event["ts"][:10]
    recent.incr(f"revenue:{day}", event["amount"])   # no history, and no way to correct itself
    if event["amount"] > FRAUD_THRESHOLD:
        alerts.publish(event)                        # act now, not in tomorrow's report


# BATCH PATH — the whole day, exact, hours later.
# Files are partitioned by date, so one day's recompute reads one day's folder
# rather than the entire lake:  lake/events/dt=2026-08-01/part-*.parquet
def recompute(day, lake, serving):
    rows = lake.read(f"events/dt={day}/part-*.parquet")   # splittable format, parallel readers
    total = sum(r["amount"] for r in rows)                # late arrivals are included this time
    serving.put(f"revenue:{day}", total)                  # overwrite whatever the speed path guessed

# The overwrite is what makes the pair work, and it is also the bill: two
# implementations of "revenue", in two engines, that have to agree forever.
```

```sql summary="SQL — schema-on-read, and the partition column that decides the bill"
-- Nothing was validated on the way in. The columns are named here, when
-- somebody asks a question, rather than when the data arrived.
SELECT
  CAST(payload ->> 'customer_id' AS BIGINT)  AS customer_id,
  CAST(payload ->> 'amount'      AS NUMERIC) AS amount
FROM raw_events
WHERE dt BETWEEN '2026-07-01' AND '2026-07-31'   -- partition column: 31 folders read, not 3 years
  AND payload ? 'amount';                        -- rows without the field are skipped, not rejected

-- Filter on anything that is NOT the partition column and the engine has to
-- open every file in the lake to find out. The predicate looks identical in
-- the query plan and reads every folder of the 3 years instead of 31, about 35 times more.
```

## In the wild
<!--meta block=wild-->

- **Apache Spark** — A distributed processing engine where the same DataFrame code runs as a scheduled batch job over files in the lake and, through Structured Streaming, as a continuous job over arriving records — so the same transformation code can be reused on both paths; results still need comparing (production-check-7). {#wild-spark}
- **Apache Kafka** — A durable partitioned log used as the ingest buffer. Consumers hold their own offsets, so setting retention long enough turns reprocessing into replaying the log from an earlier offset with new code — the mechanism the one-path design depends on. {#wild-kafka}
- **Apache Parquet** — The columnar file format most lakes land in. It is splittable, so nodes read separate chunks of one file in parallel, and its footer statistics let a reader skip whole row groups and columns the query never mentions. {#wild-parquet}
- **Apache Iceberg** — A table format over files in object storage: it tracks which files make up a table, so writers get snapshot isolation, schemas evolve without rewriting data, and a query can be run against the table as it stood earlier. Delta Lake occupies the same layer. {#wild-iceberg}
- **Apache Flink** — A stream processor built around event time rather than arrival time. Watermarks state how late an event may be before its window closes, so the handling of a late arrival becomes an explicit policy instead of an accident. {#wild-flink}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Partition granularity** — The column and period the files are laid out by, usually a time period matching the processing schedule. It decides how much a query has to open before it can filter, so it is usually the largest lever on both runtime and cost, and bytes scanned per query will show it.
- **Target output file size** — How large each written file is. Too small and readers spend their time opening files rather than reading them; too large and a partition stops splitting across nodes evenly. Time one open against one read and pick the size where opening is a small share.
- **Cluster size against runtime** — More nodes finish sooner but scaling is rarely linear, so halving the nodes usually less than doubles the runtime and can cut the bill. Measure runtime and cost at two sizes before choosing.
- **Stream window and allowed lateness** — The width of the aggregation window and how long after it closes a late event is still accepted. This is where you decide, explicitly, what the fast answer is permitted to miss. Read the late-arrival rate (signal 5) to set it: allow the delay by which most events have arrived and leave the rest to the batch recompute.
- **Raw-zone retention** — How far back the untransformed data is kept. It bounds what a reprocessing run can rebuild, so it is a correctness setting rather than only a storage bill.

### Signals to watch
<!--meta polarity=signal-->

- **Ingest lag** — The gap between an event happening and it being available to query. It is the number the stream path exists to keep small, and the first thing to move when a source spikes.
- **Job runtime against its schedule interval** — A job that takes longer than the gap between its runs will eventually overlap itself. Track the ratio, not the raw duration, and alert when your slowest recent run brings it near 1.
- **Bytes scanned per query** — What the engine actually read to answer a question. A query whose scanned bytes barely fall when its date filter narrows is telling you the partitioning is not being used.
- **File count per partition** — Rising file counts at a flat data volume mean the writers are fragmenting output, and read throughput falls long before anyone notices the cause.
- **Late-arrival rate** — The share of events that reach the stream job after their window closed. It tells you how far the fast view and the recomputed view will disagree.

### Failure modes under load
<!--meta polarity=failure-->

- **Small-file explosion** — A frequently-running writer leaves thousands of tiny files per partition, and readers spend more time listing and opening them than processing. Throughput collapses with no error anywhere.
- **Skewed partition** — One key holds a disproportionate share of the rows, so a single node does most of the work while the rest of the cluster idles and the job runs at one machine speed. Compare the slowest task to the median; a large gap means skew.
- **Batch run overrunning its window** — A job that no longer fits between its runs starts while the previous one is still going, and the two contend for the same resources and sometimes the same output partition.
- **Backlog older than retention** — An outage lasts longer than the ingest buffer keeps messages, so the unread data is deleted rather than delayed. Nothing fails loudly, and the gap shows up as a hole in a chart weeks later. Check that retention exceeds the longest outage you must survive plus the time to catch up.
- **Schema drift** — A source adds, renames or retypes a field, ingestion accepts it because nothing validates on write, and the readers that project a schema start returning nulls or failing casts.

### Readiness checklist
<!--meta polarity=check-->

- Files land in a splittable format, partitioned on the column the queries actually filter by
- Reruns are idempotent per partition — a job overwrites its partition rather than appending to it
- Sensitive fields are scrubbed or tokenised before the data lands, not after
- Raw-zone retention is long enough to rebuild every downstream view from scratch
- Each workload has its own compute, so an ad-hoc query cannot starve a scheduled pipeline
- A compaction step keeps file counts per partition bounded
- The stream view and the recomputed view are compared on a schedule, and a divergence raises an alert

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Partition the dataset, process in batch and in stream {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [MapReduce](../distributed/coordination/mapreduce.md) — The batch path's execution model: partition, process each partition locally, then combine.
- [Change Data Capture](../distributed/coordination/change-data-capture.md) — Reads an operational database's log to feed the pipeline without asking the source system to change.
- [Materialized View](../distributed/coordination/materialized-view.md) — The serving layer is a precomputed view: queries hit a shaped result, not the lake.
- [Pipe-and-Filter](./pipe-filter.md) — Each processing stage takes a partition, transforms it, and passes it on, which is what makes stages independently scalable.
- [Workflow Orchestration](../distributed/coordination/workflow-orchestration.md) — Give the recurring movement one owner, so you can say what landed and when

**Often confused with**

- [Big Compute](./big-compute.md) — Both fan work across many machines, but this one distributes a dataset and moves the work to where the data sits.

**Prevents**

- [Busy Database](../../hazards/busy-database.md) — Moves analytical reads to a separate store, so an analyst's query stops competing with checkout.

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — The batch path and the streaming path are both sold here, which is what this architecture needs.

<!-- relationships:end -->
