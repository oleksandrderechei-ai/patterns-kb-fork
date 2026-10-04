---
title: Chain of Responsibility
description: Passes a request along a chain of handlers
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, separation-of-concerns, extensibility, composition]
status: stable
aliases: [CoR]
solves: [my request handling is a giant if/else ladder that everyone has to edit, I want to add an auth check before my handlers without touching any of them, the caller has to know about every object that might deal with a request, reordering my processing steps means rewriting the code that calls them, each new validation rule I add makes one function longer and uglier]
---

# Chain of Responsibility

Hands a request down a line of handlers — each free to deal with it or pass it along — so the sender never needs to know who finally answers.

## What it is
<!--meta block=description-->

A chain of responsibility links handler objects in a line. A request enters at the head, and each handler either deals with it or forwards it to its successor, so the sender never names the receiver. It replaces an if/else ladder with a list you can reorder or rebuild at run time. Without a catch-all at the tail, a request can fall off the end unhandled.

## Explained
<!--meta block=explain-->

A chain of responsibility links handlers in a line, each holding a reference to the next. A request enters at the first handler, which either answers it or passes it on, so the sender never names who answers. Choose it over an if/else ladder when the set of handlers, or their order, comes from configuration rather than code, because adding or reordering a handler then touches no caller. For three fixed cases the ladder is shorter and reads on one screen.

- **Silent drop.** A request can fall off the end and nothing throws. Add a last handler that always answers and logs.
- **Hidden path.** The path lives in a list built at run time, so log which handler took each request and test every order you ship.

**Example.** An expense system routes claims through a team lead (limit 1,000 dollars), a director (10,000) and a finance chief (50,000). A 4,200 dollar claim skips the team lead and the director signs it, after two checks. A 60,000 dollar claim passes all three and falls off the end: with no last handler it returns nothing and the employee waits forever. The fix is a fourth handler that rejects anything it receives and logs the claim id. Put the finance chief first by mistake and every claim, even a 20 dollar one, lands on that desk, and nothing in the chain complains.

## How it works
<!--meta block=structure-->

```mermaid caption="A request walks the chain. Any handler may answer it and stop, or forward it. If none does, it falls through the tail."
flowchart LR
    Req(["Request"]) -->|"dispatch"| A["Handler A"]
    A -->|"handles it"| Out(["Done"])
    A -->|"passes on"| B["Handler B"]
    B -->|"passes on"| C["Handler C"]
    C -->|"no handler"| Miss(["Unhandled"])
```

## Variations
<!--meta block=variations-->

- **Pure vs. impure chain** — In the pure form exactly one handler consumes the request and stops; in the impure form several handlers may act on it as it flows past.
- **Middleware / interceptor pipeline** — Each handler does part of the work then calls `next()` — the shape behind servlet filters, Express middleware, and ASP.NET pipelines.
- **Hierarchical bubbling** — The successor link points up a tree instead of along a list; DOM (Document Object Model) event bubbling and exception propagation are chains that climb a hierarchy.
- **[Command](./command.md)** — Wrap each request as a Command object and let it travel the chain; handlers execute it or forward it untouched.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The sender never names the handler that answers**, so the two can change independently.
- **Each handler does one small job**, so you can test it on its own.
- **Reorder, add, or drop handlers** at runtime without touching the callers.
- **Adding a handler** means slotting one in, not editing the ones already there (the [open/closed principle](../../../principles/open-closed.md)).

### Cons
<!--meta polarity=con-->

- **A request can slip past every handler** and go unanswered — nothing guarantees a match.
- **The logic is scattered across a runtime list**, so the flow is harder to trace and debug.
- **Every extra handler adds another** call and a little latency to each request.
- **One wrong order** — or a handler that forgets to pass the request on — silently breaks the chain.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Several objects could handle a request** and you only learn which one fits at runtime.
- **You want to fire a request** at a group of handlers without hard-coding which one receives it.
- **The handlers**, and the order they run in, need to be configurable.

### Avoid when
<!--meta polarity=avoid-->

- **One object always handles the request** — call it directly; that reads clearer.
- **Every request must be handled** — here a request that falls through becomes a silent bug.
- **The order never changes** — a plain, explicit sequence beats the extra indirection.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an expense-approval chain, each approver forwarding what it can't sign off"
interface ExpenseRequest { readonly employee: string; readonly amountUsd: number }

type Decision = { outcome: "approved"; by: string } | { outcome: "denied"; reason: string };

abstract class Approver {
  private next?: Approver;
  linkTo(next: Approver): Approver { this.next = next; return next; } // links read left-to-right

  review(req: ExpenseRequest): Decision {
    if (this.canApprove(req)) return { outcome: "approved", by: this.role };
    if (this.next) return this.next.review(req);   // over my limit — pass it up
    return { outcome: "denied", reason: "exceeds every approval limit" };
  }
  protected abstract readonly role: string;
  protected abstract canApprove(req: ExpenseRequest): boolean;
}
class TeamLead extends Approver {
  protected readonly role = "team lead"; protected canApprove(r: ExpenseRequest) { return r.amountUsd <= 1_000; }
}
class Director extends Approver {
  protected readonly role = "director"; protected canApprove(r: ExpenseRequest) { return r.amountUsd <= 10_000; }
}

// build the chain, then let a request walk it
const chain = new TeamLead();
chain.linkTo(new Director());

chain.review({ employee: "Mara", amountUsd: 4_200 });
// → { outcome: "approved", by: "director" }
```

## In the wild
<!--meta block=wild-->

- **Express.js middleware** — Functions with the (req, res, next) signature run in registration order; each either ends the cycle by sending a response or calls next() to pass control on. Calling next(err) skips straight to the error-handling middleware, distinguished by its four-argument (err, req, res, next) signature. {#wild-express}
- **Java Servlet Filters** — Each filter doFilter(request, response, chain) does its work then calls chain.doFilter() to reach the next filter; skipping that call short-circuits the request. Order comes from web.xml filter-mapping declarations or the @WebFilter annotation, and the same chain wraps the response on the way back out. {#wild-servlet-filter}
- **ASP.NET Core middleware** — The pipeline is built in Program.cs from app.Use(...) components that receive a next delegate and decide whether to invoke it; app.Run(...) is terminal and never calls next. Registration order is execution order, and each component can run code both before and after awaiting the rest of the pipeline. {#wild-aspnet-core}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Chain order** — The sequence handlers run in is the primary dial: auth before rate-limit before routing. Reordering changes behavior with no change to the handlers themselves.
- **Terminal handler** — Whether a catch-all sits at the tail. Its presence decides whether an unmatched request gets a default response or silently drops off the end.
- **Chain length** — Each handler adds a stack frame and a little latency to every request that passes; keep the chain as short as the routing logic allows.
- **Short-circuit policy** — Which handlers may end the request versus which must always forward. This governs where the chain can terminate early and where it must fall through.

### Signals to watch
<!--meta polarity=signal-->

- **Unhandled-request rate** — Count of requests that reach the tail without being consumed: the observable symptom of a missing or misordered handler.
- **Per-handler latency** — Time each handler contributes; a chain-wide p99 that climbs faster than any single handler points at chain depth itself.

### Failure modes under load
<!--meta polarity=failure-->

- **Silent fall-through** — A request matches no handler and drops off the end with no response or a bare 404, looking like a routing bug rather than a chain bug.
- **Forgotten forward** — A handler neither consumes the request nor calls next(); every downstream handler is skipped and the request stalls or returns nothing.
- **Order regression** — A handler placed after one that short-circuits never runs: logging installed after auth never sees rejected requests.

### Readiness checklist
<!--meta polarity=check-->

- A terminal catch-all handler is installed so no request can fall off the end unhandled.
- Handler order is pinned by a test, since the sequence is behavior and not incidental.
- Every handler either consumes the request or forwards it, so none can silently drop it.
- Each handler is timed so chain depth shows up in latency traces.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Send a request through a line of handlers until one deals with it. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Command](./command.md) — Commands flow along a handler chain
- [Composite](../structural/composite.md) — A node's parent becomes its successor, so requests bubble up the tree
- [Intercepting Validator](../../security/intercepting-validator.md) — A validator chain is the textbook request-filter use
- [Front Controller](../../enterprise/front-controller.md) — A request chain is how a front controller runs the shared steps

**Often confused with**

- [Decorator](../structural/decorator.md) — One handler may stop the request; a decorator normally passes it on, though a cache or check can stop it too

<!-- relationships:end -->
