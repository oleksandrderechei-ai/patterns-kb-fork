---
title: Compute
description: "Virtual machines (VMs), containers and functions — how much of the machine you keep, and what each cloud calls it"
area: capabilities
owner: Oleksandr Derechei
tags: [operations, resource-management, isolation, cloud]
status: stable
aliases: [cloud compute, instances]
solves: [I know the AWS compute service but not what it is called on Azure or Google Cloud, we are paying for servers that sit idle overnight and at the weekend, "I cannot tell whether this should be a container, a function or just a virtual machine", our function is killed at its time limit halfway through a long job, we moved to another cloud by picking the same-sized instance and everything got slower]
---

# Compute

The spectrum of rented compute, from a virtual machine you patch yourself to a function that runs for forty milliseconds — what each shape costs you in control, what every cloud calls it, and where the choice reaches into the code.

## What the cloud gives you here
<!--meta block=description-->

Every cloud rents the same spectrum of compute, from a virtual machine you patch yourself to a function that exists only while a request runs. You choose how much of the machine stays your problem, and the billing unit decides what your code may assume. This page maps each rung to what every cloud calls it.

## Explained
<!--meta block=explain-->

Compute is machine time you rent at one of several levels: a virtual machine you patch yourself, containers a service runs for you, or a function that exists only while a request is being handled. Each level up takes work off you and bills in smaller units. A function can be torn down between any two requests, so it must be a [stateless service](../patterns/distributed/routing/stateless-service.md). Choose by how busy the work is and how much of the machine you must control, not by what sounds modern. Work that runs most of the day is cheapest on instances you keep, because per-request pricing is a premium for not paying for idle time. Whatever you pick meets one limit first: the regional quota on cores and accelerators, which rises through a support ticket with a lead time, not a slider.

- **Cold start.** The first request after an idle spell waits while a copy boots; shrink the package, or pay for pre-warmed copies where sold.
- **Execution ceiling.** A job that runs too long is killed; split it into steps run by a durable workflow engine.
- **Per-request pricing.** It can overtake a machine you keep; move the busy service down a level and leave bursty ones up.
- **Regional quota.** A raise takes a support ticket with a lead time, so ask in the quarter before you need it.

**Example.** Take illustrative prices: an always-on small instance costs 30 dollars a month, and a function costs 0.00002 dollars per request all in. A webhook receiver gets 50,000 requests a month, so the function costs 1 dollar against 30, and it wins. The break-even is 30 divided by 0.00002, which is 1.5 million requests a month. A busy API at 5 million requests a month costs 100 dollars as a function, while two instances cost 60, so you move it down a level. The function's cost is a cold start: the first request after an idle spell waits an extra second while a copy boots.

## The capabilities
<!--meta block=capabilities-->

- **Virtual machine** — An operating system running on hardware you share with strangers, rented by the second and yours to patch. It is the shape with the fewest assumptions attached, which is why every lift of software you did not write lands here first.
- **Instance family and size** — The provider's catalogue of machines, grouped into families tuned for a different bottleneck — general purpose, memory-heavy, compute-heavy, storage-heavy — and sized within each family. Pick the family from the resource your workload actually runs out of, because buying a balanced machine to get at its memory is how a compute bill quietly doubles.
- **[Autoscaling](../patterns/distributed/routing/autoscaling.md) group** — A machine template, a target count and a control loop that adds or removes identical instances to hit it. It turns a fixed fleet into capacity that follows load, and it only works while any one instance can vanish mid-request without a user noticing.
- **Interruptible capacity** — Spare capacity at a steep discount, which the provider may reclaim on short notice when a full-price customer wants it back. It is the right home for batch work, build runners and anything a retry repairs, and the wrong home for the only copy of a long-lived process.
- **Container image registry** — A private store for the images your builds produce, with access control and vulnerability scanning attached. Every container runtime on the cloud pulls from it, so it is the piece you need before any of the container options below become usable.
- **Serverless container runtime** — A service that runs your image on request and charges for the time it runs, with no cluster, no nodes and no patching on your side. It is the shortest path from a container to production, and it scales to zero — which is also why the first request after an idle spell is the slow one.
- **Managed [Container Orchestration](../patterns/distributed/coordination/container-orchestration.md)** — A scheduler you declare a desired state to, with the control plane run and upgraded by the provider while the worker nodes stay yours. Reach for it when many services need one scheduling, networking and rollout model; the cost is a team that owns the platform, so it should be carrying more than one service.
- **Serverless function** — A single handler the provider runs on an event and bills per invocation and per millisecond of execution. It has a hard execution ceiling, no durable local disk and no life between requests, which makes it excellent glue and a poor home for anything that takes its time.
- **[Managed application platform](../comparisons/application-platforms.md)** — Hand it a repository or an artifact and it builds, runs and fronts the result with a load balancer and a URL. It is the fastest route from code to a running address, and what you trade away is the control you will want on the day you outgrow its defaults.
- **Accelerator compute** — Instances with GPUs or vendor-designed AI chips attached, rented by the hour like any other machine. Training and high-volume inference are what justify it, and the constraint that bites is regional availability and quota rather than the hourly rate.
- **Single-tenant hardware** — A physical server dedicated to you, with no other customer's workloads on it. You buy it for a licence counted per physical core or for a rule that forbids shared hardware, and you pay for the whole machine whether or not you fill it.
- **Batch and HPC scheduling** — A queue of jobs, the dependencies between them, and a service that provisions machines to drain the queue and shuts them down afterwards. It is the difference between running ten thousand independent jobs and first writing the thing that runs ten thousand independent jobs.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Virtual machine | Amazon EC2 | Azure Virtual Machines | Compute Engine | KVM, OpenStack |
| Instance sizing vocabulary | instance type | VM size | machine type | OpenStack flavors |
| Autoscaling group of identical VMs | EC2 Auto Scaling group | Virtual Machine Scale Sets | Managed instance groups | OpenStack Heat autoscaling groups |
| Interruptible discounted capacity | EC2 Spot Instances | Azure Spot Virtual Machines | Spot VMs | no direct open-source equivalent |
| Custom machine image | Amazon Machine Image (AMI) | VM image in Azure Compute Gallery | Compute Engine custom image | HashiCorp Packer (BUSL) |
| Dedicated single-tenant hardware | EC2 Dedicated Hosts | Azure Dedicated Host | Sole-tenant nodes | no direct open-source equivalent |
| GPU-attached compute | EC2 P and G instance families | N-series VMs | Compute Engine GPUs, accelerator-optimized machine types | no direct open-source equivalent |
| Container image registry | Amazon ECR | Azure Container Registry | Artifact Registry | Harbor |
| Serverless container runtime | AWS Fargate | Azure Container Instances, Azure Container Apps | Cloud Run | Knative |
| Managed Kubernetes | Amazon EKS | Azure Kubernetes Service | Google Kubernetes Engine | Kubernetes (you operate it), k3s |
| Kubernetes pods without managing nodes | EKS with Fargate | AKS with virtual nodes | GKE Autopilot | no direct open-source equivalent |
| Serverless function | AWS Lambda | Azure Functions | Cloud Run functions | OpenFaaS, Knative |
| Managed application platform | AWS Elastic Beanstalk | Azure App Service | App Engine | Dokku |
| Blue/green deployment with instant rollback | AWS CodeDeploy blue/green deployments | Azure App Service deployment slots | Cloud Run revision traffic splitting | Argo Rollouts, Flagger |
| Progressive canary rollout | CodeDeploy canary deployment configurations | App Service slot traffic percentage | Cloud Run gradual traffic migration | Argo Rollouts, Flagger |
| Batch and HPC job scheduling | AWS Batch | Azure Batch | Batch | Slurm |
| Stateful workflow orchestration | AWS Step Functions | Azure Durable Functions, Logic Apps | Workflows | [Temporal](../comparisons/workflow-orchestrators.md), Airflow |
| Cloud-managed on-premises hardware | AWS Outposts | Azure Local | Google Distributed Cloud | no direct open-source equivalent |
| Rolling update of a fleet | EC2 Auto Scaling instance refresh | Virtual Machine Scale Sets rolling upgrades | Managed instance group rolling updates | Kubernetes Deployment rolling update |
| Container image build | AWS CodeBuild | Azure Container Registry Tasks | Cloud Build | Docker BuildKit, Cloud Native Buildpacks |
| Virtual actors with per-instance state | no first-party equivalent | Azure Durable Functions entities | no first-party equivalent | Microsoft Orleans, Dapr actors, Akka |
| Runtime configuration and feature flags | AWS AppConfig, Systems Manager Parameter Store | Azure App Configuration | Parameter Manager, Firebase Remote Config | etcd, Consul, OpenFeature with flagd |
| Scheduled job trigger | Amazon EventBridge Scheduler | Azure Functions timer trigger, Logic Apps Recurrence trigger | Cloud Scheduler | Kubernetes CronJob |

## Choosing between them
<!--meta block=choosing-->

Start at the rung that takes the most work off you, and climb down only when something forces you. A managed platform or a serverless container runtime asks for an artifact and returns a running URL. A virtual machine asks for an operating system, a patch schedule, a [Load Balancer](../patterns/distributed/routing/load-balancer.md) in front of it and a [Health Endpoint](../patterns/distributed/resilience/health-endpoint.md) for that balancer to probe — which is [Prefer Managed Services](../principles/managed-services.md) applied to the machine itself, and the reason the rung you pick is an operations decision more than a technical one.

| If you need… | Choose | Because |
| --- | --- | --- |
| To run software you are not allowed to change | Virtual machines | Same operating system, same disks, same install script — nothing about the application has to move |
| To run one HTTP service you own and can rebuild | Serverless container runtime | The image is the whole contract, and there is no cluster to patch or to pay for while idle |
| Ten services under one networking and rollout model | Managed Kubernetes | One scheduling API covers all of them, at the price of a team that owns the platform |
| Glue that fires on an event and finishes in seconds | Serverless function | Billed per invocation, costs nothing between events, and needs no process kept alive |
| A first deployment with no infrastructure decisions | Managed application platform | Push the repository, get a URL, and defer every platform choice until you have traffic |
| Work that is cheap to restart and expensive to run | Interruptible capacity | The discount is large; reclamation is the price, and an automatic retry is what pays it |
| Thousands of jobs with dependencies between them | Batch scheduling service | The queueing, retries and provisioning are already written, and writing them is a project |
| Model training or high-volume inference | Accelerator compute | The gap over CPU-only is an order of magnitude, so it is a different timescale, not a tuning job |

The break-even between per-request and reserved pricing is duty cycle, and it is worth working out before the invoice works it out for you. Per-millisecond billing wins outright while a service sits idle most of the time — an internal tool, a webhook receiver, a nightly job — because the meter stops between calls. Once that same service is busy through the working day you are paying a premium for a meter you no longer need, and a comparably sized instance left running costs less. Re-run the comparison every time traffic moves by an order of magnitude, because neither answer stays correct.

Two constraints settle the shape before price gets a vote. Regional quota comes first: vCPU, GPU and concurrent-execution limits are set per account, per region and often per family, they are the ceiling you meet on launch day, and raising one is a support ticket with a lead time rather than a slider — when a region's quota binds, the move is a second copy of the whole stack elsewhere, a [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md), rather than a larger request in the same place. The deploy you want to be able to perform comes second: [Canary Release](../patterns/distributed/routing/canary-release.md) and [Blue-Green Deployment](../patterns/distributed/routing/blue-green-deployment.md) both need instances that are interchangeable and disposable, which is the property [Design to Scale Out](../principles/scale-out.md) asks for and the one every rung above the virtual machine gives you for free. Pick the compute shape that makes that deploy cheap, because retrofitting it onto a fleet already holding session state is a rewrite rather than a migration.

## What does not port
<!--meta block=portability-->

- **Instance sizes never map by name**: two clouds can both sell you four vCPUs and sixteen gigabytes and mean different processor generations, different memory bandwidth and different attached storage. Re-benchmark your workload on candidate sizes, because porting a size by its name is how a migration lands slower with nothing in the bill to explain it.
- **Local disk does not survive the machine**: storage attached to the host disappears when the instance is stopped, resized or relocated to other hardware, on every cloud and under a different name each time. Use it for scratch space, and keep the copy that matters somewhere the instance's lifetime cannot reach.
- **Scale-to-zero is paid for in latency**: a runtime that keeps nothing warm has to start a container, a language runtime and your process before it serves the first request, and how long that takes varies sharply by provider and by language. Measure the cold path with your own artifact and budget for it in the p99, not the average.
- **The execution ceiling on a function differs per provider**: every cloud caps how long a single invocation may run, and no two caps are the same number. A job that fits comfortably on one cloud is a job that gets killed on another, so check the ceiling before you port and split long work into steps behind a durable orchestrator.
- **Regional quota is the limit you meet first**: vCPU, GPU and concurrency limits are granted per account and per region, and they stop a launch long before price becomes the argument. Ask for the increase weeks ahead and confirm it in the region you will actually run in, because a quota granted in one region buys you nothing in another.
- **Managed Kubernetes ports at the manifest level and not below it**: the API objects move across clouds, and the load-balancer controller, ingress, storage classes, identity integration and node autoscaler underneath them do not. Budget the move as rebuilding the platform layer rather than as copying YAML.
- **Spot reclamation warnings are short and unequal**: every provider tells you before it takes capacity back, the notice is measured in seconds to a couple of minutes, and no two are the same length. Write the shutdown handler against the shortest notice among your targets, and never let the discount depend on a graceful exit you have not tested under load.
- **Machine images do not cross clouds**: an image is a provider-specific format bound to that provider's virtualization, guest agent and metadata service, so moving one means rebuilding it rather than exporting it. Keep the build reproducible from source, and the image becomes an artifact you regenerate instead of an asset you are stuck with.

## Patterns it implements
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Generalizes**

- [Application Platforms](../comparisons/application-platforms.md) — The application-platform product decision, argued in full

**Requires**

- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Elastic compute can only add and remove instances if no instance holds the only copy of anything.
- [Health Endpoint Monitoring](../patterns/distributed/resilience/health-endpoint.md) — The platform decides what to restart and what to route to by polling this.
- [Containerization](../patterns/distributed/coordination/containerization.md) — Managed container runtimes take an image and run it — producing that image stays your job.

**Implements**

- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — Scale sets, autoscaling groups and managed instance groups are this pattern as a platform feature.
- [Blue-Green Deployment](../patterns/distributed/routing/blue-green-deployment.md) — Deployment slots and managed rollouts do the swap for you.
- [Canary Release](../patterns/distributed/routing/canary-release.md) — Weighted traffic splitting across revisions is built into the managed runtimes.
- [Container Orchestration](../patterns/distributed/coordination/container-orchestration.md) — Managed Kubernetes is this control loop rented by the hour: you declare the desired state, the service reconciles it.
- [Big Compute](../patterns/architecture/big-compute.md) — Batch and high-performance computing (HPC) schedulers acquire the cores, run the job and release them, which is the whole shape of this.
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — Step Functions and Durable Functions persist each step, so a crash resumes instead of restarting.
- [Rolling Deployment](../patterns/distributed/routing/rolling-deployment.md) — Instance refresh, scale set rolling upgrades and managed instance group updates replace a fleet in batches for you.
- [Actor Model](../patterns/concurrency/actor-model.md) — Durable entities and the open-source actor runtimes give each actor its own state and a single-threaded mailbox.
- [External Configuration Store](../patterns/distributed/coordination/external-configuration-store.md) — A managed configuration store holds settings outside the deployment, so changing one is an API call rather than a redeploy.
- [Feature Flag](../patterns/distributed/routing/feature-flag.md) — Managed flag services evaluate and roll out flags for you, with targeting and gradual percentages built in.
- [Compensating Transaction](../patterns/distributed/resilience/compensating-transaction.md) — A workflow engine records each step, so it can run the undo steps in reverse when a later one fails.
- [Saga](../patterns/distributed/coordination/saga.md) — Workflow engines run a saga as a durable sequence of steps, each with its compensation.
- [Asynchronous Request-Reply](../patterns/distributed/routing/async-request-reply.md) — Durable Functions answers 202 with a status URL; Step Functions and Workflows return an execution you poll.
- [Compute Resource Consolidation](../patterns/distributed/routing/compute-resource-consolidation.md) — Kubernetes packs many small workloads onto shared nodes.
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — A scheduled trigger runs the sweep on a fixed cadence.
- [Scheduling](../patterns/concurrency/scheduling.md) — A managed scheduler starts jobs on a cron or rate schedule.

<!-- relationships:end -->
