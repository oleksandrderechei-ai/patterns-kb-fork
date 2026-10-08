---
title: Fork-Join
description: "Split a task into parts, run them in parallel, join the results"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, throughput]
status: stable
aliases: [divide and conquer, fork/join]
solves: [one core is at 100% while the other seven sit idle on a big sort or sum, a large array takes seconds to process and I want to cut it across cores, I split work into tasks but some finish long after the rest and cores sit idle, each piece of my job needs the answers of its smaller pieces before it can finish]
---

# Fork-Join

Split a big task into smaller independent tasks, run them in parallel, then wait once and join their results into one answer.

## What it is
<!--meta block=description-->

Summing ten million numbers or sorting a large array on one thread leaves the other cores idle. Fork-join cuts the job in two (fork), cuts each half again until a piece is small enough to run directly, and runs the pieces in parallel on a pool of workers. Each task then merges its pieces' results (join). With P workers the job takes about total work divided by P plus the longest chain of dependent steps.

## Explained
<!--meta block=explain-->

Fork-join splits a task into smaller tasks (fork), runs them in parallel, and waits for their results so it can combine them (join). A task that is small enough runs directly, and a larger one splits itself and joins its parts. A [thread pool](./thread-pool.md), usually with one worker per core, runs the pieces, and an idle worker steals queued pieces from a busy one, so uneven pieces keep cores busy while queued pieces remain. Choose it over a [barrier](./barrier.md) when the work splits once and merges once, and over a plain queue of independent jobs when each task needs the answers of its parts.

- **Tiny tasks lose time.** Creating a task costs more than a very small piece of work. Set a sequential cutoff and tune it.
- **Blocking starves the pool.** A worker stuck on I/O leaves a core idle. Keep tasks CPU-only and send blocking work elsewhere.
- **Merge can stay serial.** Joining on one thread caps the gain. Merge in parallel, or shrink what each join combines.

**Example.** Summing 100 million numbers takes 100 ms on one core. Split with a cutoff of 10,000 elements, the job becomes 10,000 pieces of 10 microseconds each. A fork costing 200 ns adds 2%, so eight cores finish in about 13 ms. Set the cutoff to 10 and there are 10 million pieces of 10 ns work, each paying 200 ns to fork. That is about 2.1 s of task cost, 260 ms on eight cores, which is slower than the one-core loop. A sum reads memory once, so bandwidth can cap the gain below 8x; measure the speedup. The counter-move is the cutoff, and you find the right value by measuring.

## How it works
<!--meta block=structure-->

```mermaid caption="How does one big task use every core? Steps 2 and 3 split it until the pieces are small, and steps 5 and 6 merge the answers back up, so only the root task waits for the whole job."
flowchart TB
    R["Root task: whole input"]
    subgraph Pool["Worker pool, one worker per core"]
        L["Left half task"]
        H["Right half task"]
        Q[("Work queues: idle workers steal from busy ones")]
    end
    S["Small piece: run directly"]
    M["Merged result"]
    R -->|"1 too big: fork"| L
    R -->|"2 too big: fork"| H
    L -->|"3 queue the pieces"| Q
    Q -->|"4 a worker takes a piece"| S
    S -->|"5 return a partial result"| L
    L -->|"6 join the halves and merge"| M
    H -->|"6 join the halves and merge"| M
```

```mermaid caption="A task forks one half, runs the other itself, then joins. The forked half may run on another worker, and join waits for its result."
sequenceDiagram
    participant P as Parent task
    participant W as Another worker
    P->>P: size above the cutoff, split in two
    P->>W: fork(left half)
    P->>P: compute the right half directly
    W->>W: compute the left half
    W-->>P: left result
    P->>P: join: merge left and right
```

## Variations
<!--meta block=variations-->

- **Recursive task** — Each task splits itself until it is below a cutoff, then computes directly. Java's `RecursiveTask` (returns a value) and `RecursiveAction` (returns none) are this form.
- **Flat fan-out** — Cut the input into N equal chunks up front, run them, join once. It has no recursion and fits uniform work, but a skewed chunk leaves a straggler.
- **Work-stealing pool** — Each worker keeps its own queue and an idle worker takes tasks from the far end of a busy worker's queue. Uneven pieces still keep every core busy.
- **Parallel loop and parallel stream** — A library forks the loop body over a range or collection for you. The cutoff and pool become library defaults you may need to tune.
- **Structured scope** — A block starts child tasks and cannot exit until all finish. In Go, an `errgroup` made with `errgroup.WithContext` cancels the shared context when a child returns an error, so siblings that watch the context can stop, and `Wait` returns the first error. A zero `Group` only waits.
- **[MapReduce](../distributed/coordination/mapreduce.md) at cluster scale** — The same split, process and merge across machines, where the join becomes a network shuffle.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Uses every core on divide-and-conquer work** — a job that takes 80 ms on one core can approach 10 ms on eight.
- **Uneven pieces still balance** — work stealing moves queued pieces to idle workers, so you do not need to predict each piece's cost.
- **Code mirrors the recursion** — split, compute, merge reads like the serial algorithm.
- **Pieces share nothing while they run** — each works on its own slice, so no lock is needed inside a piece.

### Cons
<!--meta polarity=con-->

- **Forking below the right size loses time** — task creation costs more than a tiny piece of work; set a sequential cutoff and tune it by measuring.
- **Blocking inside a task starves the pool** — a worker stuck on I/O or a lock takes a core out of service; keep tasks CPU-only and put blocking work on another pool.
- **Merge can become the new serial part** — joining results on one thread caps the gain; merge in parallel or reduce the data merged.
- **A split that is uneven leaves a straggler** — one huge piece decides the finish time; split by cost, not by count, and split into more pieces than cores.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **The work is CPU-bound and splits into independent parts** — sort, sum, search, image tiles, tree walks.
- **A piece needs its children's answers** — the parent must merge before it can finish.
- **Piece costs vary** — work stealing evens out what a fixed split would leave uneven.

### Avoid when
<!--meta polarity=avoid-->

- **The work is mostly waiting on I/O** — use [futures](./future-promise.md) or an event loop; fork-join workers would sit blocked.
- **Parts depend on each other every round** — a [barrier](./barrier.md) fits lock-step phases better than a one-shot split.
- **The input is small** — a few microseconds of work will not repay the cost of forking.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — parallel sum by recursive split, with a sequential cutoff"
const cutoff = 10_000 // below this, forking costs more than the work

func sum(a []int) int {
	if len(a) <= cutoff {
		s := 0
		for _, v := range a {
			s += v
		}
		return s // small enough: compute directly
	}
	mid := len(a) / 2

	var left int
	done := make(chan struct{})
	go func() { // fork: left half runs on another goroutine
		left = sum(a[:mid])
		close(done)
	}()
	right := sum(a[mid:]) // this goroutine takes the other half itself

	// a panic in the goroutine above never reaches this join; real code recovers it and passes the error through done
	<-done // join: wait for the left result
	return left + right
}
```

## In the wild
<!--meta block=wild-->

- **Java ForkJoinPool** — Added in Java 7 with `RecursiveTask` and `RecursiveAction`. Workers steal tasks from each other, and parallel streams and parallel array sorts run on its shared common pool. {#wild-java-forkjoinpool}
- **Rust rayon** — A data-parallelism crate. `rayon::join` forks two closures and joins them, and `par_iter` turns an iterator into a parallel one on a work-stealing pool. {#wild-rust-rayon}
- **.NET Task Parallel Library** — `Parallel.For`, `Parallel.ForEach` and `Parallel.Invoke` split work across a pool and return when all parts finish. {#wild-dotnet-tpl}
- **oneTBB** — Intel's threading library offers `parallel_for` and `parallel_invoke` on a work-stealing task scheduler. {#wild-onetbb}
- **Cilk and OpenCilk** — The language extension that made the model well known: `cilk_spawn` forks a call and `cilk_sync` joins, on a work-stealing runtime. {#wild-cilk}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **parallelism level** — The number of workers, usually one per core. In Java it is the `ForkJoinPool` constructor argument. The common pool defaults to `availableProcessors() - 1` workers, and `java.util.concurrent.ForkJoinPool.common.parallelism` sets it.
- **sequential cutoff** — The piece size below which a task computes directly. It balances forking cost against idle cores and is found by measuring.
- **split ratio** — Halves for uniform work, or by cost for uneven work. More pieces than cores gives stealing room to balance.
- **pool separation** — Whether unrelated jobs share one pool. A separate pool keeps a slow job from taking every worker.

### Signals to watch
<!--meta polarity=signal-->

- **steal count** — How often workers take tasks from each other. Some stealing is normal; a count that stays high while some cores idle suggests an uneven split. Java exposes `getStealCount`.
- **queued task count** — Tasks waiting for a worker. A queue that keeps growing means too few workers or tasks that are too heavy. Java exposes `getQueuedTaskCount`.
- **per-core CPU use** — Cores below full use during the job mean a serial part, an uneven split or blocked workers.
- **speedup against one core** — Elapsed time on one core divided by elapsed time on N. A gap from N shows the cutoff, the merge or memory bandwidth.

### Failure modes under load
<!--meta polarity=failure-->

- **over-splitting** — Millions of tiny tasks spend more time in task creation and queues than in work, and the job runs slower than serial.
- **blocked workers** — Tasks that wait on I/O or locks take workers out of service, so the pool has fewer cores than you paid for.
- **shared pool starvation** — Unrelated work on the common pool, such as another parallel stream, slows every other user of that pool.
- **serial merge** — Joins on one thread leave most cores idle at the end, and extra cores add nothing.

### Readiness checklist
<!--meta polarity=check-->

- a sequential cutoff is set and chosen by measurement, not by guess
- tasks do CPU work only, and blocking calls run on a separate pool
- a one-core run and an N-core run are timed, and the speedup is acceptable
- an exception in a subtask surfaces at the join and fails the whole job as intended
- the pool is sized to the cores you actually have, container limits included

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Split work into pieces, run them in parallel and merge the results. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Thread Pool](./thread-pool.md) — Runs the small pieces on a pool of workers, often one that lets idle workers steal queued pieces
- [Future / Promise](./future-promise.md) — Each fork returns a handle to its result, and the join waits on it
- [MapReduce](../distributed/coordination/mapreduce.md) — Same split and merge on one machine's cores; mapreduce does it across machines, where the join becomes a network shuffle

**Alternative to**

- [Barrier](./barrier.md) — Ends each task at the join and starts new ones for the next phase, so a finished worker takes new pieces instead of waiting for a phase to end

**Often confused with**

- [Scatter-Gather](../messaging/scatter-gather.md) — Splits work across threads in one process that share memory; scatter-gather sends a request to separate services over a network and collects the replies

<!-- relationships:end -->
