---
title: Workflow orchestrators
description: "Durable execution engines, batch directed acyclic graph (DAG) schedulers and cloud state machines — which multi-step work each one is built to finish"
area: comparisons
owner: Oleksandr Derechei
tags: [coordination, asynchrony, cloud]
status: stable
aliases: [temporal, airflow, argo, prefect, step functions, durable functions]
solves: [our multi-step process dies halfway and nobody retries it, I cannot tell whether a cloud state machine or a code-based engine should run our multi-step process, cron jobs with dependencies are becoming spaghetti, a payment flow spans five services and has to finish or unwind, the retry and timeout code around our long job is bigger than the job]
---

# Workflow orchestrators

Two different jobs answer to one name: keeping a multi-step application transaction alive across crashes, and running a scheduled graph of batch jobs. Temporal, Airflow, Argo, Prefect and the cloud state machines each serve one of them first.

## What this compares
<!--meta block=description-->

Split the field on the job before you compare products. One job keeps a multi-step application transaction alive across a crash: charge the card, reserve the stock, book the courier, then finish or unwind. The other runs a batch pipeline on a clock, where a failed date must be re-run. Each product does the other job badly. Each cloud also sells a state machine of its own, cheapest to run and costliest to leave.
## Explained
<!--meta block=explain-->

A workflow orchestrator runs a sequence of steps and remembers where each run got to, so a crash between steps does not lose the run. For application transactions, choose a durable execution engine such as Temporal, which resumes the run on another worker and keeps the undo logic in reviewable code. For batch pipelines, where step four waits on steps two and three and a failed date must be re-run, choose a scheduler such as Airflow. Inside one cloud with modest branching, the cloud's own state machine is the least to operate. Before any of them, try less: see choosing.

- **A durable engine costs a cluster.** It needs a server cluster and a database, or a vendor bill.
- **A cloud state machine's definition ports nowhere.** It is written in the provider's language, so accept a rewrite if the work moves.
- **Replay needs deterministic code.** Side effects belong in activities, the steps that can run more than once, so make them safe to repeat.

**Example.** A shop handles 10,000 orders a day, and each runs three steps: charge, reserve stock, book a courier. One order in 500 loses its process after step 2, so 20 orders a day are charged with no delivery booked. A status column plus a sweeper job can find them, but you write the sweeper and the refund path. A durable engine resumes each stranded order at step 3, or runs the refund you wrote beside the happy path. The cost is a cluster to run, or a vendor bill.

## The contenders
<!--meta block=contenders-->

- **Temporal** — Durable execution: you write the workflow as ordinary code, and the engine replays it from an event history after a crash, so retries, timers and compensation are code you can review. MIT-licensed — self-host the server against your own database, or buy Temporal Cloud from the vendor.
- **Apache Airflow** — A batch DAG (directed acyclic graph) scheduler: pipelines are Python files, and the product owns the calendar, the dependencies and the backfill of a date that failed. Apache-2.0, and managed for you as Amazon MWAA, Google Cloud Composer or Astronomer's Astro.
- **AWS Step Functions** — A state machine declared in JSON, priced per state transition, with direct integrations into the rest of AWS so many steps need no code at all. Proprietary and fully managed: nothing to run, and the definition ports nowhere.
- **Argo Workflows** — Kubernetes-native orchestration: every step is a container, every workflow is a custom resource, and the cluster is the runtime. Apache-2.0 and a CNCF (Cloud Native Computing Foundation) project — you add a controller to a cluster you already run.
- **Prefect** — Python-first dataflow with less machinery than Airflow: flows and tasks are decorated functions, and the schedule sits on the deployment. Apache-2.0 — self-host the server or use Prefect Cloud.
- **Azure Durable Functions and Logic Apps** — Two shapes of the same job on Azure: Durable Functions orchestrate code-first inside Azure Functions, while Logic Apps start from a designer aimed at integration flows. Logic Apps is proprietary; the Durable Functions extension and the Durable Task Framework are MIT-licensed. Both run as Azure services.
- **Google Cloud Workflows** — Steps declared in YAML or JSON that call services in turn and keep the run's position for you. Proprietary and managed.

## How they compare
<!--meta block=matrix-->

| Criterion | Temporal | Airflow | Argo Workflows | Prefect | Cloud state machines |
| --- | --- | --- | --- | --- | --- |
| Job it serves first | Application transactions | Scheduled data pipelines | Container job graphs | Python dataflow | Service coordination inside one cloud |
| A workflow is written as | Code in your language | A Python DAG file | A Kubernetes custom resource | Decorated Python functions | A JSON or YAML definition; code in Durable Functions |
| A worker dies mid-step | History is replayed, the run resumes in place; workflow code must be deterministic, with side effects in activities | The task re-runs on a later scheduler pass | The controller retries the step's pod | The run engine retries the task | Step Functions Standard workflows resume from the last transition; Express workflows keep no history to resume from |
| Language reach | Go, Java, TypeScript, Python, .NET | Python | Any language, inside a container | Python | Any service the definition calls |
| License | MIT | Apache-2.0 | Apache-2.0, CNCF | Apache-2.0 | Proprietary, except the MIT-licensed Durable Functions extension |
| Someone else runs it | Temporal Cloud | Amazon MWAA, Cloud Composer, Astro | No first-party managed service | Prefect Cloud | Managed by definition |
| Compensating a half-done run | Written as code beside the happy path | Failure callbacks and trigger rules; no compensation model | Exit handlers | Not a first-class concept | Catch and fallback states |
| Kubernetes coupling | None required | Optional executor | Required | Optional | None |
| Self-hosted ops burden | A server cluster plus a database | Scheduler, workers and a metadata database | One controller on a cluster you have | A server plus a database | None |
| Shape of the lock-in | Workflow code moves with you | DAGs move between managed forms | Moves with any cluster | Flow code moves with you | The definition ports nowhere |
| What you pay for | Your infrastructure, or usage on Temporal Cloud | The machines the scheduler and workers sit on | Cluster capacity | Your infrastructure, or usage on Prefect Cloud | Per transition or per step, by the provider |

## Choosing between them
<!--meta block=choosing-->

For a multi-step application transaction, take Temporal, self-hosted or on Temporal Cloud. The compensation logic sits in reviewable code beside the happy path, which is what you notice during an incident, not during evaluation.

Inside one cloud, with modest branching and services the provider already runs, the native state machine is less to operate and less to learn. Take that trade knowingly: you are agreeing to rewrite the definition if the workload ever moves.

For scheduled data pipelines, Airflow is the common starting point, and its managed forms remove the part teams dislike. Take Prefect when the pipeline does not earn Airflow's weight, and Argo when everything you run is already a container on Kubernetes, since the orchestrator then costs you one controller instead of a platform.

Before any of them, try doing less. A queue, an idempotent consumer and a status column on the row carry more multi-step processes than people expect. Reach for a real orchestrator when branching, timers and human approval steps start appearing inside that consumer. That is when hand-rolled coordination stops being the cheaper option. A sweeper job for stuck status rows is an early sign.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Messaging & Eventing](../capabilities/messaging.md) — The stateful-orchestration row of the cloud messaging table, argued out: which engine to run when a queue and an idempotent consumer stop being enough

**Implements**

- [Saga](../patterns/distributed/coordination/saga.md) — Temporal and the cloud state machines run the saga for you — the compensating steps become code or a definition the engine replays, not retry scaffolding in your service
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — The engines that make a long process durable, argued one against another.
- [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) — How each engine runs the undo steps when a run fails half-way.
- [Scheduling](../patterns/concurrency/scheduling.md) — Airflow and Prefect own the calendar and re-run a failed date.

<!-- relationships:end -->
