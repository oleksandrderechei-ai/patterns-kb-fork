---
title: Data & Analytics
description: "Lake, pipeline, warehouse and model layer — and what every cloud calls each stage"
area: capabilities
owner: Oleksandr Derechei
tags: [data-modeling, data-access, read-optimization, transformation, cloud]
status: stable
aliases: [analytics, big data, data platform]
solves: [I know the AWS analytics service but not what Azure or Google Cloud call it, our dashboards run straight against the production database and checkout gets slow every morning, the same report costs pennies on one cloud and hundreds on another and nobody can explain why, we want to move the warehouse and nobody can tell me whether the data comes with it, every new question means a ticket for an engineer to write another job]
---

# Data & Analytics

The pipeline from raw events to answers — where the data lands, what moves and reshapes it, what queries it, and the search and model layer on top — plus what each cloud calls every stage and which parts you cannot take with you.

## What the cloud gives you here
<!--meta block=description-->

What you buy here is a pipeline, not a product: raw events land in cheap durable storage, jobs reshape them, a query engine answers questions, and a search and model layer sits on top. Providers sell it as one service per stage or as a bundle, and the file format you keep your data in sets the price of leaving.

## Explained
<!--meta block=explain-->

Data analytics is a pipeline you rent in stages: raw events land in cheap durable storage, jobs reshape them, and a query engine answers questions over the result. Your product database is built for writes, so you ask your questions of a separate copy built for scanning, the split [CQRS](../patterns/architecture/cqrs.md) makes inside one service. Decide on three things and expect them to disagree. Freshness: a nightly load is one job you can re-run, so buy a one-minute lag only where someone acts within seconds. Query shape: engines that bill by bytes scanned reward a few big scheduled scans, so price your real query mix, not the per-terabyte headline. File format, because it outlasts the rest: open column files in object storage are readable by any engine, while a warehouse's private format turns leaving into a full export. Compare the assembled pipeline against a bundled platform, not one service against one service.

- **Fresh data.** A one-minute lag needs a change stream and consumers that cope with seeing a change twice; first ask what an hour-old answer costs.
- **Per-viewer scans.** A dashboard that re-reads for every viewer bills every refresh; precompute a summary table and accept it is up to an hour old.
- **Private format.** Leaving a warehouse is an export at transfer prices; keep the authoritative copy in open files and query it from the warehouse.
- **Bundled platform.** It gives fewer seams and one security model, but you can swap and bend less of it.

**Example.** Illustrative bytes-scanned price: 5 dollars per terabyte. A dashboard has 200 viewers, each refreshing 20 times a day, and each refresh scans 50 GB. That is 200 times 20 times 50 GB, or 200 TB a day, which costs 1,000 dollars. Instead, one scheduled query runs hourly and writes a small summary table that every viewer reads. It scans 24 times 50 GB, or 1.2 TB a day, which costs 6 dollars. The price you pay is freshness: the dashboard is up to an hour old.

## The capabilities
<!--meta block=capabilities-->

- **[Data lake storage](../patterns/distributed/routing/object-storage.md)** — Object storage holding raw and processed data as files, partitioned by date or tenant and usually written in a columnar format. It is the cheapest durable place to keep everything you might one day want to ask about, and the stage every other stage reads from.
- **Metadata catalog and governance** — A registry of which datasets exist, what columns they hold, who owns them and who may read them. Without it a lake becomes a folder of files nobody can find, and access control has to be re-invented inside every query engine separately.
- **[Batch extract, transform, load (ETL) and pipeline orchestration](../patterns/architecture/pipe-filter.md)** — Scheduled jobs that read from one place, reshape the rows and write them somewhere else, plus a scheduler that knows which job depends on which. The scheduler is the part people underestimate: retries, backfills and the dependency graph become most of the work once you pass a handful of jobs.
- **[Distributed batch compute](../patterns/distributed/coordination/mapreduce.md)** — A managed cluster that splits a large dataset across many machines, runs your code on each piece and combines the results. Reach for it when the transformation needs real code or non-tabular data; if the transformation is SQL, the warehouse will do it for less.
- **Stream ingestion** — An append-only, partitioned log that accepts events at high rate and holds them for a fixed retention window. It decouples producers from consumers, and its retention window is the maximum amount of history you can replay after a consumer bug.
- **[Stream processing](../patterns/concurrency/batching.md)** — A managed runtime that reads the log continuously and computes windowed aggregates, joins and enrichments as events arrive. Some runtimes handle one event at a time and others accumulate micro-batches, which is the difference between sub-second and multi-second freshness.
- **Cloud data warehouse** — A columnar SQL engine with its own storage layout, tuned for scanning billions of rows and returning an aggregate. It is where analysts live, and the one component whose pricing model varies enough between providers to invert a cost comparison.
- **[Query-in-place over object storage](../patterns/messaging/scatter-gather.md)** — A SQL engine that reads lake files directly, fanning the scan across workers and merging their partial results, with no load step and no cluster kept warm between questions. It wins for occasional questions over data you already have, and loses to a loaded warehouse on anything asked hourly.
- **Business intelligence and dashboards** — A modelling layer plus a chart tool, so people who do not write SQL can ask bounded questions. Its real job is to fix one shared meaning for "active user" and stop two dashboards disagreeing about it.
- **[Managed search and vector index](../patterns/ml/embeddings.md)** — A service that indexes documents for keyword search and stores vectors so you can retrieve by similarity rather than by exact term. It is priced on the capacity you keep online rather than on bytes at rest, so an index queried once a day costs what a busy one does.
- **[ML training and deployment platform](../patterns/ml/feature-engineering.md)** — A managed environment for notebooks, training jobs, a model registry and an endpoint that serves predictions. It buys you the undifferentiated parts — accelerator provisioning, experiment tracking, staged rollout — and it is the least portable thing in this category.
- **Foundation-model platform** — An API over hosted large models, with fine-tuning, grounding against your own data and safety filtering around them. You are renting inference capacity and a model you did not train, so the questions that decide the purchase are token pricing, context limits and what the provider does with a prompt you send.
- **Retrieval, features, evaluation and agent runtime** — Services that sit on top of a model platform: retrieval that grounds answers in your documents, a store that serves the same features to training and inference, scoring of model output against a test set, and a runtime that runs a model in a tool-calling loop. You buy them to avoid building plumbing, and each ties you to the provider's model and index formats.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Data lake storage | Amazon S3 | Azure Data Lake Storage | Cloud Storage | Ceph; [MinIO](../comparisons/object-stores.md)'s community repository is archived |
| Metadata catalog | AWS Glue Data Catalog | Microsoft Purview | Dataplex | Hive Metastore |
| Batch ETL pipelines | AWS Glue | Azure Data Factory | Cloud Data Fusion | [Apache Airflow](../comparisons/workflow-orchestrators.md) |
| Managed Spark | Amazon EMR | Azure Databricks | Dataproc | Apache Spark |
| Stream ingestion | Amazon Kinesis Data Streams | Azure Event Hubs | Pub/Sub | [Apache Kafka](../comparisons/message-brokers.md) |
| Stream processing | Amazon Managed Service for Apache Flink | Azure Stream Analytics | Dataflow | Apache Flink |
| Cloud data warehouse | Amazon Redshift | Microsoft Fabric Warehouse; Azure Synapse Analytics | BigQuery | ClickHouse |
| Query-in-place over object storage | Amazon Athena | Azure Synapse serverless SQL pool | BigQuery external tables | Trino, DuckDB |
| Business intelligence | Amazon Quick Sight, in Amazon Quick | Power BI | Looker; Looker Studio | Apache Superset, Metabase |
| Managed search and vector search | Amazon OpenSearch Service | Azure AI Search | Vector Search (Gemini Enterprise Agent Platform) | [OpenSearch](../comparisons/search-engines.md) |
| ML training and deployment | Amazon SageMaker | Azure Machine Learning | Gemini Enterprise Agent Platform, formerly Vertex AI | Kubeflow, MLflow |
| Foundation-model platform | Amazon Bedrock | Microsoft Foundry Models | Model Garden (Gemini Enterprise Agent Platform) | no direct open-source equivalent |
| Managed retrieval for model grounding | Amazon Bedrock Knowledge Bases | Azure AI Search | RAG Engine (Gemini Enterprise Agent Platform) | LlamaIndex, Haystack |
| Feature store | Amazon SageMaker Feature Store | Azure Machine Learning managed feature store | Feature Store (Gemini Enterprise Agent Platform) | Feast |
| Model and prompt evaluation | Amazon Bedrock Evaluations | Microsoft Foundry evaluation | Gen AI evaluation service (Gemini Enterprise Agent Platform) | MLflow |
| Managed agent runtime | Amazon Bedrock AgentCore | Microsoft Foundry Agent Service | Agent Runtime (Gemini Enterprise Agent Platform) | LangGraph |
| Managed agent memory | Amazon Bedrock AgentCore Memory | Microsoft Foundry Agent Service memory | Memory Bank (Gemini Enterprise Agent Platform) | Mem0, Letta |
| Sandboxed code execution for agents | Amazon Bedrock AgentCore Code Interpreter | Azure Container Apps dynamic sessions | Code Execution (Gemini Enterprise Agent Platform) | E2B |
| Managed MCP tool gateway | Amazon Bedrock AgentCore Gateway | Azure API Management MCP servers | Apigee MCP support | no direct open-source equivalent |

## Choosing between them
<!--meta block=choosing-->

Start from how fresh the answer has to be, then from how often the question gets asked. Batch is the default and should stay the default: land the raw files, transform on a schedule, query the result — a job you can re-run over yesterday is a job you can debug. Move a stage to streaming only when a person or a system acts on the answer within seconds, and expect to pay for it in operational complexity rather than in compute.

| If you need… | Choose | Because |
| --- | --- | --- |
| Occasional questions over files you already have | Query-in-place engine | You pay per query and keep no cluster warm between them |
| The same questions every hour, from many people | Loaded data warehouse | Repeated scans over a tuned layout cost a fraction of re-reading raw files |
| Transformations that are all SQL | Load raw, transform in the warehouse | The engine you already pay for does the work, with no second cluster to size |
| Transformations needing real code or non-tabular data | Managed Spark | Arbitrary code over partitioned data is the job it exists for |
| A dashboard that loads instantly for everyone | Precomputed aggregates, a [Materialized View](../patterns/distributed/coordination/materialized-view.md) per question | Each viewer reads a result computed once, not a join computed per viewer |
| An answer within seconds of the event | Stream processing over an ingestion log | Nothing scheduled can beat its own schedule interval |
| One team, and nobody to run the plumbing | A bundled analytics platform | At that size, fewer integration seams is worth more than best-of-breed parts |
| Several teams running several engines on one dataset | Open table format on the lake | Every engine reads the same files, and no engine owns the data |

The unit a warehouse bills in decides your bill, and it is not the same unit everywhere. Some price a query by the bytes it scans, some by the compute you keep provisioned while it runs, and some by a capacity unit you reserve ahead of time. A handful of large scheduled queries is cheapest under bytes scanned, a dashboard that refreshes for every viewer is cheapest under provisioned compute, and the ranking flips when the workload does. Run your real query mix against each pricing model before you commit, because no headline per-terabyte number survives contact with it.

Freshness costs more than volume. Keeping a warehouse within a minute of the operational database means a [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) stream and consumers that tolerate seeing the same change twice, because ordered delivery off a log is at-least-once. Streaming adds a partitioning decision on top: events are ordered only within a partition, so the key you pick both defines the ordering you get and decides whether one tenant's traffic concentrates on one shard while its peers idle — the [Hot Partition](../hazards/hot-partition.md) hazard, arriving through the ingestion layer. [Streaming](../themes/streaming.md) walks the whole shape; ask what an hour-old answer actually costs before you buy any of it.

Do not buy the model layer as a separate thing. Training features come out of the same batch and streaming jobs that feed the dashboards, and the classic failure is the training path and the serving path computing one feature two different ways — which surfaces as a model that scored well offline and moves nothing in production, so [Evaluation](../patterns/ml/evaluation.md) has to span both. Prefer a platform that trains against your lake instead of one that wants its own copy, and keep each feature defined in exactly one place. [ML System Design](../themes/ml-system-design.md) covers how those pieces fit together, and [Gen AI at Scale](../themes/genai-scale.md) covers the serving side once the model is a hosted one you rent.

## What does not port
<!--meta block=portability-->

- **The pricing unit is not the same unit**: warehouses charge for a query by the bytes it scans, by the compute kept provisioned while it runs, or by a reserved capacity unit. The same workload has a different cost shape under each, and the cheapest provider inverts between a few large scheduled scans and a stream of small interactive ones — so a per-terabyte comparison tells you nothing about your bill.
- **SQL does not lift**: every warehouse speaks SQL and none of them speaks the same one. Date handling, semi-structured access, window function edge cases and the whole user-defined function story differ, so budget for rewriting and re-testing every non-trivial query rather than for a search and replace.
- **The table format is the exit**: data written as open columnar files with an open table format on top is readable by any engine you point at it, and data inside a warehouse's proprietary internal format is readable only by that warehouse. This is the single decision that most determines whether you can leave, and it gets made early by whoever writes the first loading job.
- **Product names churn faster here than anywhere else in cloud**: analytics and AI services get renamed, folded into umbrella platforms and re-launched more often than storage or compute do. Treat the capability column of the table above as the durable part, and re-check the product names against the provider's own documentation before you quote them to anyone.
- **Retention windows set your maximum replay**: a streaming service holds events for a fixed window, and that window differs between providers and between tiers of the same provider. It is the hard limit on how far back you can reprocess after a consumer bug, so size it against how long a bad deployment can plausibly go unnoticed rather than accepting the default.
- **Orchestration ports only if it is Airflow**: a job graph written for Apache Airflow moves between managed Airflow offerings once you rewrite the connectors. A pipeline built in a provider's own visual designer does not move at all, and re-authoring it costs what the original build cost.
- **Notebooks and ML artifacts are the least portable thing here**: training jobs, pipelines, model registries and endpoints are expressed in each platform's own SDK, and the notebook that produced a model usually imports it. Keep training code in plain framework calls behind a thin adapter, or accept that the model layer pins you harder than the data does.
- **Governance does not travel with the data**: column masks, row filters, classifications and lineage live in the catalog rather than in the files, so copying a dataset to another cloud copies the bytes and none of the rules. Re-implementing them is a compliance project, and it is why a lake migration takes far longer than the transfer does.

## Patterns it implements
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Change Data Capture](../patterns/distributed/coordination/change-data-capture.md) — The change stream off the operational store is where most analytics pipelines start.

**Implements**

- [MapReduce](../patterns/distributed/coordination/mapreduce.md) — Managed Spark and the serverless query engines run this without a cluster to operate.
- [Pipe-and-Filter](../patterns/architecture/pipe-filter.md) — Managed pipeline services are this pattern with the stages as a product.
- [Batching](../patterns/concurrency/batching.md) — Warehouse loads and stream windows batch on your behalf.
- [Big Data](../patterns/architecture/big-data.md) — The batch path and the streaming path are both sold here, which is what this architecture needs.
- [Object Storage](../patterns/distributed/routing/object-storage.md) — A data lake is object storage with a catalogue over it — the blobs never move into the warehouse.
- [Embeddings](../patterns/ml/embeddings.md) — Managed search and vector services store and query embeddings for you.
- [Retrieval-Augmented Generation](../patterns/ml/rag.md) — Managed knowledge-base services chunk, index and retrieve your documents for a model.
- [Feature Engineering](../patterns/ml/feature-engineering.md) — Feature stores serve one set of computed features to both training and inference.
- [Evaluation](../patterns/ml/evaluation.md) — Evaluation services score model output against a test set and report the result.
- [AI Agent](../patterns/architecture/ai-agent.md) — Managed agent runtimes host the model, tool calls and session state for you.
- [Agent Memory](../patterns/ml/agent-memory.md) — Managed memory stores and recalls what an agent learned across sessions.
- [Agent Sandboxing](../patterns/security/agent-sandboxing.md) — An isolated session runs the code an agent writes, away from your hosts.
- [Model Context Protocol](../patterns/distributed/routing/mcp.md) — A managed gateway exposes your APIs as MCP tools, with authentication in front.
- [Inverted Index](../patterns/distributed/coordination/inverted-index.md) — Every managed search engine keeps an inverted index; you rent it with the service.
- [Agent2Agent](../patterns/distributed/coordination/a2a.md) — The managed agent runtimes host and call agents over the A2A protocol.

<!-- relationships:end -->
