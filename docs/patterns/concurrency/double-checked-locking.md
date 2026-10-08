---
title: Double-Checked Locking
description: "Check a lazy value without the lock, and lock only to create it once; correct only with the right memory ordering"
area: concurrency
owner: Oleksandr Derechei
tags: [concurrency, lifecycle]
status: stable
aliases: [DCL, double-checked locking idiom]
solves: ["taking a lock on every read of a lazy value is slow, though only the first call needs it", a thread sometimes gets an object whose fields are still empty right after startup, my lazy singleton works in tests but crashes once in a million starts, two threads both built the lazy object because both saw it as empty]
---

# Double-Checked Locking

A lazy-initialization idiom that tests whether the value exists before taking the lock and again after, so only the first callers pay for the lock; it is broken without correct memory ordering.

## What it is
<!--meta block=description-->

Reads of a lazy value skip the lock after first creation: test, lock, test again, create. Without a barrier on the published reference, a thread can see a half-built object, so use a volatile field, an atomic or a once primitive.

## Explained
<!--meta block=explain-->

Lazy initialization under a lock makes every read pay for the lock, though only the first call needs it. Double-checked locking skips the lock once the value exists: read the shared reference without the lock, and if it is empty take the lock, check again, build the object and publish it. Only callers that arrive before the object exists ever lock. The idiom is correct only when publishing the reference carries a memory barrier (an instruction that stops the CPU and compiler reordering memory operations across it). Without one a reader can see the reference before the constructor writes, and use a half-built object. Choose it only when your language has no once primitive and a lock on each read shows in a profile.

- **Silent breakage.** A missing barrier fails rarely, depending on compiler and hardware. Use a volatile field, an atomic or a once primitive.
- **No safe form on old runtimes.** Before the Java 5 memory model no source form was safe. Use a holder class or eager static.
- **Small gain.** An uncontended lock costs tens of nanoseconds. Measure before you add the idiom.

**Example.** A service reads a lazy config 2 million times a second across 16 threads. Locking each read at about 25 ns adds 50 ms of lock work every second, 5% of one core, plus contention; the profile decides whether that matters. With the idiom, each read after startup is one load. In the broken form, a reader can see a non-null pointer whose fields are still zero, and the service can crash on rare starts, depending on compiler and hardware. The fix is small: declare the field volatile in Java, use sync.Once in Go, or load with acquire ordering in C++.

## How it works
<!--meta block=structure-->

```mermaid caption="How do later readers avoid the lock? Step 1 is the unlocked fast path, step 4 is the second check that stops two creators, and the publish in step 5 must carry a memory barrier."
flowchart LR
    T["Calling threads"]
    subgraph Slow["Slow path, once"]
        L["Lock"]
        CK["Second check"]
        MK["Build the object"]
    end
    V[("Shared reference")]
    T -->|"1 read, no lock"| V
    V -->|"2 empty: go to the slow path"| L
    L -->|"3 take the lock"| CK
    CK -->|"4 still empty"| MK
    MK -->|"5 publish with a barrier"| V
    V -->|"6 later reads see the finished object"| T
```

```mermaid caption="Two threads race to the first call. B passes the first check too, then waits for the lock, and its second check finds A's object, so it builds nothing."
sequenceDiagram
    participant A as Thread A
    participant V as Shared reference
    participant B as Thread B
    A->>V: check: empty
    B->>V: check: empty
    A->>A: take lock, check again: empty
    A->>V: build and publish
    A->>A: release lock
    B->>B: take lock, check again: set
    B->>V: use A's object
```

## Variations
<!--meta block=variations-->

- **Volatile field (Java 5 and later)** — Declaring the reference `volatile` forbids the reordering that exposed half-built objects. It is the correct form on a JVM that follows the post-2004 memory model.
- **Initialization-on-demand holder (Java)** — A nested class holds the instance in a static field, and the class loader initializes it once on first use. It needs no lock of your own and no volatile.
- **Once primitive** — `sync.Once` in Go or `std::call_once` in C++ runs the creator exactly once and publishes the result safely. It is the shortest correct form.
- **Atomic with acquire and release** — In C++ or Rust, the fast path loads with acquire and the creator stores with release. A relaxed or plain load on the fast path, or a release store before the constructor's writes finish, brings back the half-built read.
- **The broken form** — A plain field with no barrier. The compiler or CPU may publish the reference before the constructor's writes, so a reader gets an object with default fields.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reads skip the lock** — after startup each read is one load, so a hot accessor costs nanoseconds instead of a lock round trip.
- **The object is built once** — the second check under the lock stops two threads creating two instances.
- **Creation stays lazy** — an expensive object that may never be needed costs nothing until first use.

### Cons
<!--meta polarity=con-->

- **It is easy to get wrong** — without a barrier a reader can see a half-built object, and the bug appears rarely, depending on compiler and hardware; in Go the unlocked read is a data race on any CPU.
- **Older runtimes cannot fix it** — before Java 5 no source form was safe, so use a holder class or an eager static there.
- **The gain is small** — an uncontended lock costs tens of nanoseconds, so benchmark the accessor with and without the lock at your real thread count and adopt the idiom only if the lock shows in a profile.
- **A once primitive does the same job** — hand-writing the pattern adds risk for no speed.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A lazy value is read on a hot path** and a lock on every read shows up in a profile.
- **The language has no once primitive** and no static initializer fits your case.
- **You can state which barrier publishes the reference**, and a reviewer can check it.

### Avoid when
<!--meta polarity=avoid-->

- **The language gives you a once primitive** — `sync.Once`, `std::call_once` or a function-local static does it correctly.
- **Creating the value at startup is cheap** — an eager static needs no check at all.
- **You cannot name the memory ordering you rely on** — use a plain lock on every read until you can.
- **The runtime predates the Java 5 memory model** — no form of the idiom is safe there.

## Code sketch
<!--meta block=sketch-->

```go summary="Go — the broken check, the correct double check, and sync.Once"
type Config struct{ url string }

var (
	mu   sync.Mutex
	inst *Config
	once sync.Once
)

// BROKEN: the unlocked read of inst races with the write. A reader can see a
// non-nil pointer before the fields behind it are visible. Run the test with go test -race to catch it.
func getBroken() *Config {
	if inst == nil {
		mu.Lock()
		defer mu.Unlock()
		if inst == nil {
			inst = &Config{url: "db://primary"}
		}
	}
	return inst
}

// CORRECT, and the one to use: Once publishes the result safely.
func getOnce() *Config {
	once.Do(func() { inst = &Config{url: "db://primary"} })
	return inst
}

var ptr atomic.Pointer[Config] // Go 1.19+

// CORRECT, hand-written: atomic load, lock, second load, store.
func getAtomic() *Config {
	if p := ptr.Load(); p != nil {
		return p
	}
	mu.Lock()
	defer mu.Unlock()
	if p := ptr.Load(); p != nil {
		return p
	}
	p := &Config{url: "db://primary"}
	ptr.Store(p)
	return p
}
```

## In the wild
<!--meta block=wild-->

- **Go sync.Once** — The standard-library once primitive. \`Do\` runs the function exactly once and publishes its result safely to every caller, which makes a hand-written double check unnecessary. {#wild-go-sync-once}
- **C++ function-local statics** — Since C++11 the standard requires a function-local static to be initialized exactly once even when threads race. \`std::call_once\` is the explicit form. {#wild-cpp-function-local-static}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Concurrency](../../themes/concurrency.md) — Avoid taking a lock on every read of a lazily created value, and know why it is subtle. {#fluency-concurrency}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Alternative to**

- [Lazy Initialization](../gof/extra/lazy-initialization.md) — A hand-written fast path that skips the lock; the once primitive that lazy-initialization names is safer where the language has one
- [Singleton](../gof/creational/singleton.md) — Often the way a lazy singleton avoids a lock on every read

**Exposed to**

- [Race Condition](../../hazards/race-condition.md) — An unlocked read without a memory barrier races with the write and can see a half-built object
- [Premature Optimization](../../hazards/premature-optimization.md) — Can fall into premature optimization when a subtle memory-model trick added to save a lock that was never the bottleneck

<!-- relationships:end -->
