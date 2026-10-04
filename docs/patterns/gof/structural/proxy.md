---
title: Proxy
description: Stand-in that controls access to another object
area: gof-structural
owner: Oleksandr Derechei
tags: [low-level-design, access-control, decoupling]
status: stable
aliases: [surrogate, stand-in]
solves: [loading this object pulls its whole object graph from the database before anyone needs it, I want a permission check in front of this object without touching the class or its callers, calling a service on another machine forces every caller to deal with sockets and serialization, every place that reads this object needs the same memoized result and I keep copying the cache logic, startup is slow because we build expensive objects that most requests never touch]
---

# Proxy

A stand-in that speaks the real object's interface exactly — so it can guard access, defer creation, cache results, or reach across the network, all without the caller ever knowing it isn't the real thing.

## What it is
<!--meta block=description-->

Callers that hold an expensive or remote object directly build it up front, wait on it with no timeout, and repeat access checks themselves. A proxy is a stand-in with the same interface in front of the real object, so callers stay unchanged. It forwards each call and can check permissions, create the object late, cache a result, or send the call to another machine. That keeps access concerns in one place, outside both the object and its callers.

## Explained
<!--meta block=explain-->

A proxy stands in front of one object with the same interface and forwards each call to it, doing extra work on the way: checking permission, building the object only when first used, caching a result, or sending the call to another machine. The caller and the real object stay unchanged. Choose it when a concern must apply on every access to one object and neither side should know about it. If callers can safely hold the real object, a proxy adds a class and a hop for nothing.

- **Hidden waits.** A call that looks local may wait on a network hop or disk, so give the proxy its own timeout and visible failures.
- **Concurrency.** Lazy creation can run twice, so guard it to happen once.
- **Interface drift.** A hand-written proxy must change every time the real interface does; a generated one follows it.

**Example.** A report viewer shows 200 thumbnails, each backed by a 5 MB image. An image proxy has the same draw method but loads the file only when it is first drawn. Opening the page now loads the 12 visible thumbnails, 60 MB, instead of all 200, 1,000 MB. The cost is that scrolling to an unloaded thumbnail now blocks on a disk read inside draw, which looks instant to the caller. Two threads drawing the same thumbnail at once can both load it, so the proxy loads under a lock.

## How it works
<!--meta block=structure-->

```mermaid caption="The proxy implements the same interface as the real subject and sits transparently between client and target, interposing on every call."
flowchart LR
    C["Client"] -->|"calls Subject interface"| P["Proxy"]
    P -->|"access control, lazy load, forward"| R["Real Subject"]
    R -->|"result"| P
    P -->|"result"| C
```

## Variations
<!--meta block=variations-->

- **Virtual proxy** — Defers building an expensive real subject until the first call that actually needs it — the classic lazy-loading stand-in.
- **Remote proxy** — A local representative for an object that lives in another address space; it marshals the call across the network and unmarshals the reply.
- **Protection proxy** — Enforces access rights, checking the caller's permissions before forwarding — or refusing.
- **Caching proxy** — Memoizes results and serves them on repeat requests, forwarding only on a miss.
- **Smart reference** — Adds bookkeeping around access — reference counts, locking, or lazy persistence — without the subject knowing.
- **[Ambassador](../../distributed/routing/ambassador.md)** — A remote proxy run as a [sidecar](../../distributed/routing/sidecar.md), a helper process on the same host as the calling service, handling that service's outbound retries, timeouts and telemetry out-of-process.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Steps in between callers and the real object** without changing either one.
- **Shares the real object's interface**, so callers need no change; a remote or lazy proxy still adds waits and failures the interface hides.
- **Keeps a cross-cutting concern** — lazy loading, access control, caching, remote calls — in one class.
- **Keeps the real object simple** and focused on its own job.

### Cons
<!--meta polarity=con-->

- **Adds a layer of indirection** — one more class and one more hop per call.
- **A blocking proxy hides real delay**: a remote call or lazy load looks instant and local, so give it its own timeout and visible failures.
- **Easy to confuse with Decorator or Adapter**, so the intent gets muddy.
- **Because it must match the real object's interface**, a hand-written proxy changes every time that interface does; generate it (a runtime proxy or generated stub) and it follows the interface without edits.
- **Stale cached results** — A caching proxy can serve a stale result until it expires or is invalidated, so give it an expiry or invalidation rule.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to control or gate access** to an object without changing its interface.
- **The real object is expensive to create** and you want to hold off until it's actually needed.
- **The object lives in another process** or on another machine, and callers shouldn't have to care.
- **You want access control** or caching in front of a target, invisibly to callers.

### Avoid when
<!--meta polarity=avoid-->

- **You want to add or change behaviour**, not just control access — that's a [Decorator](./decorator.md).
- **The interface itself needs translating** between two incompatible shapes — that's an Adapter.
- **The indirection buys nothing** and callers can safely hold the real object directly.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a virtual proxy that loads on demand"
interface Image {
  render(): string;
}

// The real object is costly to build — it decodes the file up front.
class RealImage implements Image {
  constructor(private readonly file: string) {
    this.load();
  }
  private load(): void {
    // expensive: read and decode the file's bytes
  }
  render(): string {
    return `<img src="${this.file}">`;
  }
}

// Virtual proxy: same interface, defers the costly load until first render.
class LazyImage implements Image {
  private real?: RealImage;
  constructor(private readonly file: string) {}

  render(): string {
    this.real ??= new RealImage(this.file); // build on first use only
    return this.real.render();
  }
}

const image: Image = new LazyImage("hero.png"); // nothing decoded yet
image.render();                                 // decodes now, on demand
```

## In the wild
<!--meta block=wild-->

- **Hibernate lazy loading** — For a lazily-mapped association Hibernate returns a runtime-generated proxy subclass (via Byte Buddy, historically CGLIB) holding only the identifier; the first non-id property access fires a SELECT, and doing so after the Session is closed throws LazyInitializationException. {#wild-hibernate-lazy-proxy}
- **java.lang.reflect.Proxy** — Proxy.newProxyInstance() generates a class at runtime implementing the given interfaces and dispatches every method to a single InvocationHandler.invoke(proxy, method, args) — the mechanism behind JDK dynamic proxies and much interface-based aspect-oriented programming (AOP). {#wild-java-reflect-proxy}
- **gRPC client stubs** — The generated blocking or async stub implements the service interface locally, marshals each call to protobuf and ships it over HTTP/2 to the remote server, unmarshaling the reply so callers invoke a remote method as if it were local. {#wild-grpc-stubs}
- **JavaScript Proxy** — The built-in Proxy wraps a target with a handler whose traps (get, set, has, apply, deleteProperty) intercept the matching operations while presenting the target shape; Vue 3 reactivity uses it to track property reads and writes. {#wild-js-proxy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Forwarded-call timeout** — A bound on how long the proxy waits on a call it forwards across a process or network boundary, so a slow or hung real object does not block the caller indefinitely. Set it above the observed p99 of the real object and inside the deadline of the caller, and decide whether expiry raises a distinct error or returns a fallback. For a remote or ambassador proxy this pairs with a retry and backoff policy.
- **Initialization trigger (lazy vs eager)** — A virtual proxy defers building the real object to first use. Choose whether to warm it eagerly at startup or load it on demand, trading startup cost against first-call latency.
- **Cache expiry and size bound** — How long a caching proxy keeps a result and how many entries it holds. A longer expiry raises the hit ratio and the chance of serving a stale result.

### Signals to watch
<!--meta polarity=signal-->

- **Proxy hop latency** — Added per-call time versus invoking the real object directly. For a remote proxy this p99 includes the network round trip the local interface hides.
- **First-access initializations** — Count and latency of lazy loads a virtual proxy triggers. A spike marks cold objects being built for the first time under traffic.
- **Timeout rate and blocked callers** — Forwarded calls that hit the timeout, and caller threads waiting on a proxy. A climb comes before pool exhaustion.
- **Cache hit ratio** — Share of calls a caching proxy answers without forwarding. A falling ratio means more calls reach the real object and the latency gain is shrinking.

### Failure modes under load
<!--meta polarity=failure-->

- **Hidden latency, thread pileup** — A synchronous proxy makes a remote or lazy call look local. Without a timeout a slow real object blocks the caller thread, and under load those threads pile up and exhaust the pool.
- **First-access stampede** — A virtual proxy shared across concurrent callers triggers one expensive initialization that they all block on. Without a guard, several callers each build the real object. Decide whether a failed build is retried on the next call, with backoff, or cached as a failure, so callers do not repeat it on every call.
- **Stale cached results** — A caching proxy keeps serving a result after the real object has changed, until the entry expires or is cleared.

### Readiness checklist
<!--meta polarity=check-->

- Set a timeout on any forwarded call that can block or cross a process boundary, plus, for a remote proxy, a retry and backoff policy that retries only calls safe to repeat, caps attempts and adds jitter
- Guard lazy initialization against concurrent first-access so the real object is built exactly once
- Confirm transparency: the proxy exposes exactly the interface of the real object and adds nothing beyond controlling access (gating, deferring, caching, forwarding), or it is really a Decorator or Adapter

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Structure](../../../themes/object-structure.md) — Stand in front of an object to control or defer access to it. {#fluency-object-structure}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Lazy Initialization](../extra/lazy-initialization.md) — A virtual proxy defers creation until first use

**Generalizes**

- [Ambassador](../../distributed/routing/ambassador.md) — Ambassador is a network proxy deployed beside a service

**Often confused with**

- [Decorator](./decorator.md) — Add behavior vs. control access — same shape
- [Adapter](./adapter.md) — Keeps the same interface as the real object and controls access to it

**Exposed to**

- [Leaky Abstraction](../../../hazards/leaky-abstraction.md) — Can fall into leaky abstraction when a remote proxy makes a network call look local, with no timeout or failure branch

<!-- relationships:end -->
