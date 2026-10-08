---
title: Logging Service
description: "One log call fans out to every destination, each filtering and formatting itself — an object-oriented design composing two axes without an N×M class explosion"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, composition, extensibility, separation-of-concerns, immutability]
status: stable
aliases: [logger, logging library]
solves: [supporting plain text and JSON on both console and file is exploding into a class per combination, adding a new output target means editing a giant switch inside one write method, one slow file write blocks my console output because a single lock guards everything, two threads log at the same instant and their bytes interleave into one corrupted line, a failed write to one output crashes the application that only wanted to record a message]
---

# Logging Service

A logger is the in-process library an application calls to stamp a message with a time and a severity and push it to one or more outputs — the console, a file, later maybe the network. As a low-level design it is almost entirely about shape: two things vary independently (the format and the target), several threads call it at once, and any output can fail without the caller ever wanting to know.

## Understanding the problem
<!--meta block=description-->

A logging library linked into one process, in the role of Log4j or Python's logging, where a call like logger.info reaches the destinations directly. Network shipping and aggregation are out of scope. Two axes vary at once, plain text or JSON and console or file, under concurrent callers and per-destination severity, and a remote destination must slot in later. The page is about where each responsibility belongs.

## Explained
<!--meta block=explain-->

A logging library turns one log call into one immutable record, captured once with its time and thread, and hands that same record to every configured destination. Each destination combines three separate parts chosen at startup: a minimum level, a formatter that turns a record into text, and a sink that writes the bytes. Choose this composition over one destination subclass per format-and-target pair, because format and target vary independently and pairs multiply. Put each destination's lock around only the sink write; the level check and formatting run outside it, which is safe because the record never changes. Catch a sink failure and report it on stderr, rate-limited, so a dead output is visible and cannot flood.

- **Synchronous writes.** The caller waits for the I/O, so add a bounded queue and one worker per destination when that hurts.
- **Loose ordering.** Order across threads follows who won the lock, not who called first, so rely on the timestamp.

**Example.** You have 2 formats (text, JSON) and 2 targets (console, file). One subclass per pair is 4 classes; composition is 2 formatters and 2 sinks. Adding a remote target makes it 6 pairs by subclassing, but one new sink by composition. A DEBUG record reaches a file destination set to DEBUG and is dropped by a console destination set to INFO, before any formatting. If the file is full, the write fails, a one-line message goes to stderr, and the console destination still gets the record.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Five ordered severity levels — `DEBUG < INFO < WARN < ERROR < FATAL` — with a convenience method per level.
2. Each record carries a timestamp, a level, the message, and the name of the thread that emitted it.
3. One `log()` call fans the record out to every destination configured at startup.
4. Each destination owns its own minimum level and its own format; the two vary independently, and sub-threshold records are dropped before the write.

Out of scope: hot-reloading config, async or buffered writes, log rotation, network destinations (in v1), and hierarchical named loggers — each named on purpose so it reads as deferred, not forgotten.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Thread safety** — one record's bytes never interleave with another's on the same destination; two destinations built over one shared stream are not serialised against each other, so give them one shared sink object.
- **Static config** — destinations are set once at construction and never change after.
- **Extensibility** — a remote destination must drop in later without touching `Logger`.
- **Ordering** — a single thread's calls keep their order; no strict cross-thread ordering is promised beyond each record's timestamp.

## Core entities
<!--meta block=entities-->

A noun earns a class only if it owns state, enforces a rule, or has its own lifecycle. That filter keeps the model to five pieces:

- **Logger** — the orchestrator and the surface the application calls. Holds an immutable list of destinations, captures the timestamp and thread name at call time, builds one record, and hands it to each destination.
- **Destination** — one configured output. Owns its minimum-level threshold and a reference to its formatter, runs the filter → format → write workflow, and owns the lock that guards its own resource.
- **Formatter** — an interface that turns a record into a string. Two implementations today (plain text, JSON); a new format is a new implementation and nothing else moves.
- **LogRecord** — an immutable value: timestamp, level, message, thread name. Made once in `log()` and read by every destination.
- **LogLevel** — a five-valued ordered enum, no per-level behaviour. A `DebugLevel`/`InfoLevel` class hierarchy would be over-modelling a thing that is really just a rank.

The application, the OS threads, and the individual fields are deliberately not entities — they are external, borrowed, or plain data. One abstraction is also held back on purpose: the thing that actually writes bytes (later named `Sink`) is left out of the entity list, because forcing it in here would pre-empt the inheritance-versus-composition argument the class design turns on.

## The interface
<!--meta block=interface-->

The public surface is tiny and set once: the caller hands over a fixed list of destinations at construction — no `addDestination`, no setters, no builder — and then only ever calls `log()` or one of its per-level shortcuts.

```python summary="Pseudocode — the public API"
class Logger:
    def __init__(self, destinations):   # fixed at startup, stored immutable
        ...
    def log(self, level, message):      # build one record, fan it to every destination
        ...
    def debug(self, message): ...       # one-line delegations to log(...)
    def info(self, message): ...        # ergonomics for tens of thousands of call sites
    def warn(self, message): ...
    def error(self, message): ...
    def fatal(self, message): ...
    def close(self): ...                # closes every sink
```

## How the system is built
<!--meta block=architecture-->

`Logger` keeps an immutable list of destinations. `log()` captures the moment — `now()` and the calling thread's name — once at the top, builds a single `LogRecord`, and iterates the list handing that same instance to each `Destination.write()`. A destination checks the record against its own threshold, asks its `Formatter` to serialise it, and — under a lock it owns — pushes the string through its `Sink`. Formatters and sinks are the two pluggable roles: `PlainTextFormatter`/`JsonFormatter` and `ConsoleSink`/`FileSink`. Because those two roles are separate interfaces, a destination is a concrete class that composes one of each — any format with any target is just a constructor argument.

```mermaid caption="Logger orchestrates and fans out; Destination owns the per-output invariant and its lock; format and target are two independent interfaces a destination composes."
classDiagram
    class Logger {
        -List~Destination~ destinations
        +log(level, message)
        +info(message)
        +error(message)
    }
    class Destination {
        -Formatter formatter
        -LogLevel minLevel
        -Sink sink
        -Lock lock
        +write(record)
    }
    class LogRecord {
        -Instant timestamp
        -LogLevel level
        -String message
        -String threadName
    }
    class Formatter {
        <<interface>>
        +format(record) String
    }
    class PlainTextFormatter
    class JsonFormatter
    class Sink {
        <<interface>>
        +write(formatted)
    }
    class ConsoleSink
    class FileSink {
        -String filePath
    }
    Logger "1" o-- "*" Destination : owns
    Logger ..> LogRecord : builds one per call
    Destination o-- Formatter : formats with
    Destination o-- Sink : writes through
    Destination ..> LogRecord : reads
    Formatter <|.. PlainTextFormatter
    Formatter <|.. JsonFormatter
    Sink <|.. ConsoleSink
    Sink <|.. FileSink
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Two axes of variation — compose them, don't multiply them

The whole class design hinges on one requirement: format and target vary independently.

- **One class that branches on a type field.** A single `Destination` with a `type` field and a `write()` that switches `CONSOLE` vs `FILE`. Fine for two targets, but the third adds a branch and fields only it uses (`filePath`, `socketAddress`, `kafkaTopic`), so most fields sit null and `write()` becomes a switch statement. Every new target edits existing logic — the textbook [open/closed](../principles/open-closed.md) violation. Rejected.
- **Inheritance with a template method.** Make `Destination` abstract, put the filter-and-format skeleton in `write()`, and leave subclasses only a `doWrite()` to fill in. This is the [template method](../patterns/gof/behavioral/template-method.md) pattern: the level check and the formatter call live in exactly one place, so a subclass author can't forget them. It works — but inheritance is a heavy commitment for one axis of variation, and it composes badly. The moment you want to wrap a target (buffering, retry), "wrap" under inheritance means "subclass and override," and stacking two wrappers wants three levels of hierarchy for what should be one operation.
- **Composition behind a Sink interface (chosen).** Pull the byte-writing step into its own `Sink` interface. `Destination` stays a single concrete class that owns the threshold and the formatter and delegates the write to a sink. Both the formatter and the sink are [strategies](../patterns/gof/behavioral/strategy.md) — pluggable roles chosen at construction — so the design leans on [composition over inheritance](../principles/composition-over-inheritance.md): a new output target is a new `Sink`, not a new `Destination` subclass, and any format × any target is `Destination(formatter, minLevel, sink)`.
- **Dependency inversion and precedent.** The high-level workflow depends only on the `Sink` and `Formatter` abstractions, never on `ConsoleSink` or `JsonFormatter` directly — [dependency inversion](../principles/dependency-inversion.md) in practice — which is exactly what lets the required-but-deferred `RemoteSink` drop in with nothing else touched. It is the shape real loggers converge on: Log4j separates appenders from layouts, Python's `logging` separates handlers from formatters.

Underneath all three is the same discipline — [separation of concerns](../principles/separation-of-concerns.md), read as one axis of change per class: orchestration in `Logger`, classification in `LogLevel`, serialisation in `Formatter`, output in `Sink`, and the per-output invariant in `Destination`. The inheritance variant is still defensible in an interview if you can name the tradeoff; the senior signal is reasoning about the choice, not landing on one fixed answer.

### 2 · The record is an immutable value, captured once

`LogRecord` is a [value object](../patterns/ddd/value-object.md): four read-only fields describing one moment in one thread, with no behaviour and no identity beyond its contents — a Java record, a Kotlin data class, a frozen `@dataclass`. Two things make that pay off. First, the timestamp and thread name are captured once, at the top of `log()`, not per destination — so every destination sees the identical moment for one logical event, rather than five slightly different clock reads. Second, because the record is [immutable](../patterns/functional/immutability.md) after creation and formatters are pure functions, the record and its formatters are safe to share across destinations and threads with no synchronisation at all. A dedicated type also means that adding a field later — a request id, a logger name, a context map — touches one class and the one method that builds it, instead of every signature on `Destination` and `Formatter`.

### 3 · Where the lock lives

Thread safety means one record's bytes must never split across another's on the same output. The tempting answer is to `synchronize` the whole of `Logger.log()` — correct, but a sledgehammer: a slow file write (disk full, contended I/O) then blocks every other call, including console writes that should be instant, and one lock ends up guarding five unrelated resources. The better answer puts the lock where the resource is. Each `Destination` owns its own lock and applies it around only `sink.write()` — a [monitor object](../patterns/concurrency/monitor-object.md) guarding exactly one output. Because each destination has its own lock, threads writing to different outputs never contend, so a slow file does not hold up another thread's console write. Within one `log()` call the destinations are still written in order, so a hung sink stalls its own caller and the destinations after it until the bounded-queue extension. And crucially, the level check and the formatting happen outside the critical section — safe precisely because the record is immutable and the formatter is pure, so there is nothing to race on — which keeps the locked region the smallest correct one. Holding the lock across format-and-write instead is also defensible and simpler; the throughput cost only bites when formatting is expensive and contention is high.

Each destination owns its own lock, so a slow output stalls only the threads that write to it.

```mermaid caption="Why does a slow file not hold up another thread's console write?"
flowchart TB
    Log["Logger.log() - one immutable record"]
    subgraph D1["Console Destination"]
        F1["level check + format - no lock"]
        L1["own lock: sink.write()"]
    end
    subgraph D2["File Destination"]
        F2["level check + format - no lock"]
        L2["own lock: sink.write()"]
    end
    Log -->|"same record"| F1
    Log -->|"same record"| F2
    F1 -->|"formatted string"| L1
    F2 -->|"formatted string"| L2
    L1 --> CS["ConsoleSink"]
    L2 --> FS["FileSink"]
```

### 4 · When a destination fails — and what comes next

A logger is infrastructure, so a broken output must never crash the code that called it. If `sink.write()` throws and you let it propagate, a full disk turns `logger.error("payment failed")` into a payment-processing crash, and a later destination in the [fan-out](../patterns/messaging/fan-out.md) never sees the record. Swallowing the exception inside `Destination.write()` fixes the crash but fails silently — a forensic file can sit empty for days. The production default is to swallow and emit a one-line diagnostic to a known-good fallback stream (stderr), mirroring Log4j's `StatusLogger` and Python's handler-error behaviour; the diagnostic itself must be rate-limited or a persistently failing sink floods stderr. The interval is set once per destination; suppressed failures are counted and printed with the next report. As for the deferred requirements, the shape holds: making `log()` non-blocking means a bounded queue and a single worker thread per destination (Log4j's `AsyncAppender`, Python's `QueueHandler`) — which brings its own worker-lifecycle and overflow-policy questions; hierarchical named loggers add a name and a parent pointer plus a registry `LoggerFactory`, the one place where shared global state is genuinely the requirement. Neither forces a rewrite of the core.

```python summary="Pseudocode — Destination.write, the composed workflow"
class Destination:                 # one concrete class, no hierarchy
    def __init__(self, formatter, min_level, sink, interval):
        self._formatter = formatter
        self._min_level = min_level
        self._sink = sink
        self._lock = Lock()        # this destination owns its own lock
        self._interval = interval  # minimum time between stderr reports
        self._last_report = None
        self._suppressed = 0

    def write(self, record):
        if record.level < self._min_level:
            return                 # sub-threshold: silent drop, no diagnostic

        formatted = self._formatter.format(record)   # pure — outside the lock

        with self._lock:           # critical section is only the sink write
            try:
                self._sink.write(formatted)
            except Exception as exc:
                self._report(exc)

    def _report(self, exc):
        if self._last_report and now() - self._last_report < self._interval:
            self._suppressed += 1
            return
        stderr.write(f"logger: sink write failed: {exc} ({self._suppressed} suppressed)")
        self._last_report = now()
        self._suppressed = 0
```

```mermaid caption="What happens to one log call, from capture to a failing sink? The record is captured once and shared immutably; only sink.write() runs under the lock, and a broken sink is swallowed to stderr rather than crashing the caller."
flowchart TB
    Log["Logger.log(level, msg)"] -->|"capture now() + thread once"| Rec["build LogRecord (immutable)"]
    Rec -->|"same instance to each destination"| Dest["Destination.write(record)"]
    Dest -->|"level < minLevel"| Drop["silent drop"]
    Dest -->|"format: pure, outside the lock"| Fmt["Formatter.format(record)"]
    Fmt -->|"under this destination's own lock"| Sink["Sink.write(formatted)"]
    Sink -->|"throws"| Fallback["swallow, rate-limited stderr line"]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Format and target are composed, not multiplied — any combination is a constructor call, and a new target is a new Sink with nothing else touched.
- Per-destination locks: threads writing to different destinations do not contend, and the critical section is only the sink write; within one call, destinations are still written in order.
- One immutable record built per call — every destination sees the same moment, and formatting needs no synchronisation.
- A failing sink is swallowed with a stderr diagnostic, so a failing output does not crash the caller or skip the later destinations; a sink that hangs still blocks the caller.

### What it gives up
<!--meta polarity=con-->

- Composition adds one more interface and role than inheritance — mild overhead for a system with only two targets.
- Swallowing exceptions can hide a chronically broken destination unless the stderr diagnostic is rate-limited.
- Writes are synchronous, so the caller blocks for the I/O duration; non-blocking writes need the bounded-queue extension.
- No cross-thread ordering beyond each record's timestamp — wire order reflects who won the lock, not who called first.
- The interface has no shutdown call, so file handles stay open and buffered output can be lost at exit unless `close()` is added to `Sink` and `Logger`.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — a working logger: a `Logger` owning a list of destinations, an immutable `LogRecord`, a five-value `LogLevel` enum, `log()` building a record and fanning it to each destination, and each destination dropping sub-threshold records. Basic robustness (a null message or an out-of-range level shouldn't crash). Coupling format to target at first — a single `JsonFileDestination` — is acceptable until the interviewer pushes.
- **Mid-level** — reaches the format-vs-target split largely unprompted: "any format on any target" should trigger pulling `Formatter` into its own interface and seeing that one `Destination` composing a formatter and a target beats N×M subclasses. Gives `LogRecord` its own immutable type so a future field doesn't ripple through every signature, and can hold a sensible concurrency conversation with hints.
- **Senior** — class boundaries are obvious; volunteers the inheritance-vs-composition tradeoff and lands on a `Sink` interface (or defends the inheritance variant), names dependency inversion, and captures the timestamp and thread once at the top of `log()`. Reaches per-destination locks unprompted, explains why a global lock is the wrong default and why formatting sits outside the critical section, proposes swallow-plus-stderr, and can carry the async-writes and named-logger extensions.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Composition over Inheritance](../principles/composition-over-inheritance.md) — Destination composes a Formatter and a Sink instead of subclassing one class per format×target combination
- [Strategy](../patterns/gof/behavioral/strategy.md) — Formatter and Sink are pluggable roles chosen at construction — plain-text/JSON, console/file
- [Open/Closed Principle](../principles/open-closed.md) — a new output target is a new Sink, added without editing Logger or Destination
- [Dependency Inversion Principle](../principles/dependency-inversion.md) — Destination depends only on the Sink and Formatter abstractions, never on ConsoleSink or JsonFormatter
- [Value Object](../patterns/ddd/value-object.md) — LogRecord is an immutable, identity-free record of one moment in one thread, built once and read by every destination
- [Immutability](../patterns/functional/immutability.md) — an unchanging record plus pure formatters let formatting run outside the lock with nothing to race on
- [Separation of Concerns](../principles/separation-of-concerns.md) — one axis of change per class — orchestration, classification, serialisation, output, and the per-output invariant each isolated
- [Monitor Object](../patterns/concurrency/monitor-object.md) — each Destination owns its own lock and guards only its sink write, so a slow file output can't block console output
- [Fan-Out](../patterns/messaging/fan-out.md) — One log call goes to every configured destination, each filtering and formatting on its own

<!-- relationships:end -->
