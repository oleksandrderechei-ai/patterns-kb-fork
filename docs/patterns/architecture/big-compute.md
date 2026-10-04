---
title: Big Compute
description: "Burst thousands of cores onto one finite computation, then release them"
area: architecture
owner: Oleksandr Derechei
tags: [scalability, resource-management]
status: stable
aliases: [HPC, high-performance computing]
solves: [the simulation takes eleven days on our biggest server, we need 40000 frames rendered by Thursday and one machine does 200 a day, the model needs more memory than any single machine we can buy, we need a thousand machines for six hours a month and nothing the rest of the time, the overnight risk calculation no longer finishes by morning]
---

# Big Compute

Cuts one computationally intensive job into discrete tasks, runs them across hundreds or thousands of cores at once, collects the results and gives the capacity back — so a calculation that would take a machine a fortnight finishes in an afternoon.

## What it is
<!--meta block=description-->

Some arithmetic will not fit inside a deadline or inside one machine, such as a risk model or a frame sequence. Cut the job into independent tasks. A scheduler hands them to a pool of compute nodes and collects the results, and you release the pool when the job ends. A failed task simply runs again, because each one starts from its own input.

## Explained
<!--meta block=explain-->

Big compute cuts one heavy calculation into many independent tasks. A scheduler hands them to a pool of machines, collects the results, and releases the pool when the job ends, so you pay for the burst and not for a cluster that idles between runs. Choose it over [big data](big-data.md) when the bottleneck is arithmetic and the input is small. When the input is huge and the arithmetic light, moving the data costs more than the calculation, so take the work to the data instead.

- **Slow start.** A pool that needs forty minutes adds 7% to a 10-hour job and 67% to a one-hour one, so prebuild small machine images.
- **The slowest task sets the end.** Make tasks small so each node runs many, and rerun the slowest early.
- **Chatty tasks stop scaling.** Measure the best core count per workload, and checkpoint so a lost node does not cost the run.

**Example.** A risk model has 100,000 scenarios, and each takes 6 minutes on one core. That is 600,000 core-minutes, or 10,000 core-hours, which is about 417 days on one core. On 1,000 cores each node runs 100 tasks, so the work takes 600 minutes, or 10 hours, plus a 40-minute wait for the pool: 10 hours 40 minutes. When a node dies at hour 5, you lose only the 6-minute task it was running, because each task reruns from its input alone. The cost is start-up overhead on every task: at an assumed 10 seconds, a 6-minute task loses under 3% of its time, while a 5-second task loses two thirds.

## How it works
<!--meta block=structure-->

```mermaid caption="What is finite here is both the job and the pool. The scheduler cuts the work into tasks small enough to be repeated, every free node pulls the next one until the queue is empty, and step 5 hands the machines back — which is why the cost is the burst and not a standing cluster."
flowchart LR
    Client["Client — submits the job"]
    Sched["Scheduler"]
    Q[("Task queue")]
    subgraph Pool["Compute pool — provisioned for this job, released after"]
        N1["Node 1"]
        N2["Node 2"]
        Nn["Node N"]
    end
    Store[("Shared input and output store")]
    Client -->|"1 submit job + input"| Sched
    Sched -->|"2 split into discrete tasks"| Q
    Q -->|"3 each free node pulls the next task"| N1
    Q -->|"3"| N2
    Q -->|"3"| Nn
    N1 -->|"4 read input, write result"| Store
    N2 -->|"4"| Store
    Nn -->|"4"| Store
    Sched -->|"5 queue empty, release the pool"| Pool
```

```mermaid caption="The job survives a lost node because each task is independent and repeatable. It does not survive a slow ramp: a pool that takes an hour to arrive has already spent much of the time the parallelism was supposed to save."
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Scheduler
    participant P as Compute pool
    participant T as Task on a node
    C->>S: submit job, 40 000 tasks
    S->>P: request N nodes
    Note over S,P: the ramp is not free — capacity arrives over minutes
    P-->>S: nodes ready
    loop until the queue is empty
        S->>T: dispatch the next task to a free node
        alt task completes
            T-->>S: result written to the shared store
        else node lost mid-task
            T--xS: no result
            Note over S,T: requeue that task only — the job does not restart
        end
    end
    S->>P: release every node
```

## Variations
<!--meta block=variations-->

- **Embarrassingly parallel** — Tasks never talk to each other: 40 000 frames, a million trials, one file per task. Throughput scales close to linearly with cores until the output store or input read becomes the limit (production-failure-5), ordinary networking is enough, and a lost node costs one task. This is the case worth designing for whenever the problem allows it.
- **Tightly coupled** — Every step ends with the nodes exchanging intermediate results, so the whole pool moves at the speed of the slowest participant. It needs a low-latency, high-bandwidth interconnect, and adding cores stops helping once the exchanges cost more than the compute they coordinate.
- **Task queue with [Competing Consumers](../messaging/competing-consumers.md)** — Put the tasks on a queue and let each free node take the next one instead of assigning work up front. Fast nodes take more tasks, slow ones take fewer, and nothing has to predict how long any task will run.
- **Interruptible capacity** — Rent cores that can be reclaimed at short notice, which cost a fraction of guaranteed ones. It works precisely because tasks are repeatable: losing a node is a requeue. Keep the coordinator on guaranteed capacity, and expect the job to run longer when reclamation is heavy.
- **Accelerators instead of more cores** — Some workloads — dense linear algebra, ray tracing, model training — can run many times faster per device on a GPU or another accelerator than on general-purpose cores, so measure before buying. Fewer, denser nodes also shorten the ramp and can cut the number of exchanges a coupled job has to make.
- **All-or-nothing placement** — A tightly coupled job cannot start until every rank has a node, so the scheduler holds the whole allocation back rather than starting half of it. That is why a large coupled job waits in a queue while small independent jobs stream past it, and why oversubscribing a shared cluster with coupled work wastes more than it gains.
- **Data-parallel cousin** — When the input is large rather than the arithmetic, invert the movement: partition the dataset, run the computation on the node that already holds each partition, and combine — [MapReduce](../distributed/coordination/mapreduce.md). Distributing a terabyte to a thousand nodes costs more than the calculation you were trying to speed up.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Independent tasks finish in close** to the time one task takes divided by the cores you can get, which turns a fortnight into an afternoon.
- **You pay for the burst**, not for a cluster that idles between runs, though the images, quotas and scheduler stay yours to run (con-3).
- **A lost node costs one task**, because every task can be rerun from its input alone, provided each task writes its result under its task id so a rerun overwrites rather than duplicates.
- **Problems too large** for one machine's memory become tractable by splitting the state across nodes rather than buying a bigger machine. This is the coupled case, so the exchange and checkpoint costs in con-2 and con-5 apply.
- **Specialised hardware** — accelerators, high-speed interconnects — is available for the hours you need it rather than as a capital purchase.

### Cons
<!--meta polarity=con-->

- **Getting thousands of cores** in a timely manner is itself a bottleneck. A job that waits an hour for capacity has already lost much of the advantage.
- **Coupled tasks hit diminishing returns**: past some core count, communication overhead grows faster than the compute shrinks, and more cores make the job slower.
- **The infrastructure is yours to run — images**, drivers, scheduling, quotas — and it is a standing cost even though the jobs are not.
- **A few slow tasks decide the finish time**. The job is not done until the last one is, so a straggler wastes every other node's remaining hour.
- **Coupled jobs cannot shrug off** a lost node the way independent ones can, so they need checkpointing, and a checkpoint of thousands of nodes is expensive to write and to restore.
- **The optimum core count** cannot be reasoned out from the code; it has to be measured per workload, and it moves when the input size or the hardware changes.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A computation takes too long** on one machine and divides into pieces that can run at the same time — simulation, rendering, risk modelling, parameter sweeps.
- **The same small computation** has to run thousands or millions of times over different inputs.
- **The problem needs more memory**, or more specialised hardware, than any single machine you can obtain.
- **The demand is intermittent**, so a standing cluster would sit idle for most of its life.

### Avoid when
<!--meta polarity=avoid-->

- **The work is sequential by nature** and each step needs the previous step's answer. Cores cannot buy their way past that.
- **The input is enormous** and the arithmetic is light — moving the data would cost more than the calculation, so take the work to the data with [Big Data](./big-data.md) instead.
- **The service has to answer continuously**. This style provisions, finishes and disappears.
- **Each task is so short** that scheduling and start-up dominate the work. Batch the tasks larger before adding nodes.

Answers the smell of a cluster bought for a peak that happens twice a month — and introduces its own, a pool nobody released, which is a [Resource Leak](../../hazards/resource-leak.md) measured in machine-hours.

## Code sketch
<!--meta block=sketch-->

```python summary="Python — split, dispatch, release"
# The job is a list of independent tasks. Each takes an input, produces an
# output, and can be rerun from scratch — which is what makes a lost node cheap.
def split(job, per_task=100):
    return [{"id": i, "frames": range(i * per_task, (i + 1) * per_task)}
            for i in range(job.total_frames // per_task)]

def run_task(task, store):
    out = render(store.read(task["frames"]))
    store.write(f"out/{task['id']}.exr", out)   # keyed by task id, so a rerun overwrites
    return task["id"]

def run_job(job, pool, store):
    pool.provision(nodes=job.nodes)             # the ramp: minutes, and part of the wall clock
    try:
        queue = split(job)
        for task in pool.map(run_task, queue, retries=2):   # a free node takes the next one
            job.record(task)
    finally:
        pool.release()                          # runs on failure too, or you are paying for
                                                # idle machines until somebody notices

```

```python summary="Python — why more cores eventually make a coupled job slower"
# Tightly coupled work does not scale like the sketch above. Every step ends in
# an exchange, and the exchange gets more expensive as participants are added.
def step(local, peers):
    local = advance(local)          # compute
    return exchange(local, peers)   # communicate — everyone waits for the slowest

# Time to solution, roughly: the part that cannot be split, plus the part that
# can divided by the cores, plus communication that grows WITH the core count.
def wall_clock(cores, serial=0.05, work=1.0, per_exchange=0.002):
    return serial * work + (1 - serial) * work / cores + per_exchange * cores

#    8 cores -> 0.185      22 cores -> 0.137
#   64 cores -> 0.193     256 cores -> 0.566
#
# The optimum is around 22 here, and 256 cores is worse than 8. The constants
# are workload-specific, so measure the curve rather than assuming it rises.
```

## In the wild
<!--meta block=wild-->

- **Slurm** — The open-source workload manager behind a large share of academic and national-laboratory clusters. You submit a batch script with `sbatch`, declaring how many nodes and how much wall time the job needs, and the scheduler holds the job in a queue until that allocation can be granted whole. {#wild-slurm}
- **MPI** — The Message Passing Interface, the standard tightly coupled jobs are written against. Beyond point-to-point sends it defines collective operations — broadcast, scatter, all-reduce — whose cost grows with the number of participating ranks, which is exactly where the scaling limit comes from. {#wild-mpi}
- **HTCondor** — A scheduler built for large numbers of independent tasks rather than one coupled job. It will run work opportunistically on machines that are otherwise idle and reschedule a task when its machine is reclaimed, which only works because each task is repeatable. {#wild-htcondor}
- **BOINC and Folding@home** — Volunteer computing taken to its limit: independent tasks are shipped to donated machines across the internet, results come back over ordinary networking, and a contributor who disappears mid-task costs one requeue. It is the embarrassingly parallel case with the slowest possible interconnect. {#wild-boinc}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Task granularity** — How much work goes in one task. Too small and scheduling and start-up dominate; too large and the tail of long tasks decides the finish time. Aim for enough tasks per node that one straggler is a small share of a node's work (the example runs 100), and for tasks far longer than their start-up cost.
- **Pool size** — How many nodes the job asks for. It is a curve rather than a maximum: independent work scales close to linearly, coupled work has an optimum past which more nodes make the job slower.
- **Node type and interconnect** — General-purpose cores, or accelerators, and whether the nodes are placed close enough for low-latency exchanges. Independent tasks do not care; coupled ones are decided by this choice more than by core count.
- **Retries per task** — How many times a failed task is dispatched again before the job gives up. It is what converts an unreliable pool into a reliable job, and it is also how a genuinely broken task burns a node repeatedly.
- **Guaranteed against interruptible capacity** — The share of the pool rented on terms that allow reclamation. Cheaper cores in exchange for a longer and less predictable run — safe for independent tasks, hazardous for coupled ones.

### Signals to watch
<!--meta polarity=signal-->

- **Time to first task** — How long between submitting the job and the first node actually computing. It is the ramp, it is part of the wall clock, and it is the number most often left unmeasured.
- **Per-task duration distribution** — The median against the tail. A long tail means the finish time is set by a handful of tasks while the rest of the pool sits idle.
- **Core utilisation across the pool** — The share of provisioned cores actually busy. Sustained low utilisation late in a job is the straggler problem showing up as money.
- **Task failure and retry rate** — How often tasks come back to be rerun. A rising rate points at bad nodes or at reclamation, and both change how large a pool you should ask for.
- **Cost per completed job** — Node-hours consumed against jobs finished. It is the only figure that makes the node-count decision comparable across runs, because a faster run on more nodes is not automatically a cheaper one.

### Failure modes under load
<!--meta polarity=failure-->

- **The ramp starves the job** — Thousands of cores cannot be provisioned instantly. If the job waits an hour for capacity, the parallelism has already given back most of what it was meant to save.
- **Stragglers hold the finish line** — A few tasks run far longer than the rest, so the whole pool waits for them and the last percent of the job costs as much as the first half.
- **Communication overtakes computation** — On coupled work, adding nodes past the optimum makes the exchanges cost more than the compute they coordinate, and the wall clock rises with every node you add.
- **A lost node restarts a coupled job** — Independent tasks shrug off a failure; a coupled run has to resume from its last checkpoint, so a job with no checkpoints loses everything since it started.
- **The shared store saturates on completion** — A thousand nodes finishing within the same minute write their results at once, and the output store becomes the bottleneck exactly when the job looked finished.

### Readiness checklist
<!--meta polarity=check-->

- Every task is repeatable from its input alone, and writes its output keyed by task id so a rerun overwrites rather than duplicates
- Task duration is comfortably larger than the per-task scheduling and start-up cost
- The pool is released on the failure path as well as the success path, and something alerts on a pool still running after the job ended
- The core count was measured against wall clock for this workload, not inherited from another one
- Coupled runs checkpoint often enough that losing a node costs less than restarting
- Time to first task is measured and counted as part of the job duration
- The output path has been tested with the whole pool finishing at once, not with one node

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Architecture Styles](../../themes/architecture-styles.md) — Split one problem across thousands of cores {#fluency-architecture-styles}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Scheduling](../concurrency/scheduling.md) — A coordinator decomposes the job and assigns tasks to cores, which is where the burst is actually managed.
- [Fan-In](../messaging/fan-in.md) — Thousands of independent task results have to converge into one answer before the job is done.

**Often confused with**

- [Big Data](./big-data.md) — This one distributes a single computation across cores; the data is small next to the work.
- [MapReduce](../distributed/coordination/mapreduce.md) — Both split work across many machines; map-reduce splits a dataset and moves work to the data, this splits one computation over cores.

**Exposed to**

- [Resource Leak](../../hazards/resource-leak.md) — A pool nobody released keeps billing in machine-hours; release is part of the job's end.

**Implemented by**

- [Compute](../../capabilities/compute.md) — Batch and high-performance computing (HPC) schedulers acquire the cores, run the job and release them, which is the whole shape of this.

<!-- relationships:end -->
