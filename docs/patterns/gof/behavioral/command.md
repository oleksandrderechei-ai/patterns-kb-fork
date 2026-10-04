---
title: Command
description: Turns a request into a standalone object
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, state-management, encapsulation]
status: stable
aliases: [Action, Transaction]
solves: [users keep asking for undo and my code mutates everything in place, "every button hardcodes the one object it calls, so I cannot reuse it", I want to run this operation later on a worker but it is just a method call, I have no way to log or replay what the user actually did, "the same action lives in a menu, a toolbar, and a shortcut and I wrote it three times"]
---

# Command

Packages a request — the action, its target, and its arguments — into a standalone object you can pass around, queue, log, undo, and replay long after the caller that issued it has moved on.

## What it is
<!--meta block=description-->

A command turns a request into an object. A small interface, usually one `execute()`, wraps each operation together with its receiver (the object that does the work) and arguments, and an invoker triggers it without knowing what it does. Because the call is now data, you can queue, schedule, retry, serialize, log, replay or undo it, which a plain method call, made once and gone, cannot.

## Explained
<!--meta block=explain-->

A command wraps one operation as an object that holds the thing to act on, the arguments and an \`execute()\` method. The caller triggers it without knowing what it does, and because the call is now data you can queue it, save it, send it to another machine, log it or reverse it. Choose it over passing a plain function when the operation must outlive the moment of its call, for example to undo or replay it. If you need none of that, a function does the same work with no extra type.

- **Class volume.** One class per action inflates the type count, so let simple actions share one class that takes a parameter.
- **Lost context.** The code that queued a command is not on the stack when it runs, so store who asked and when inside it.
- **Stale undo.** Saved undo state goes stale when the receiver changes, so test every command by running it, then its undo.

**Example.** A text editor records each edit as a command. You type "hello " (6 characters) and "world" (5), so the history holds two commands and the text is 11 characters long. Undo pops the last command, which removes 5 characters and leaves "hello ". Later a developer adds a cursor position to the document. Undo still restores the text but leaves the cursor at position 11, past the end of a 6-character text, and nothing fails until a user types. A test that runs the command, then its undo, and compares the whole document before and after catches it. The cost is that each of your edit kinds needs its own class and its own undo.

## How it works
<!--meta block=structure-->

```mermaid caption="The client builds a concrete command bound to a receiver and hands it to the invoker. The invoker calls execute, the command calls the receiver — invoker and receiver stay decoupled."
flowchart LR
    Client["Client"] -->|builds and binds| Cmd["Command"]
    Client -->|configures| Invoker["Invoker"]
    Invoker -->|execute| Cmd
    Cmd -->|action| Receiver["Receiver"]
```

## Variations
<!--meta block=variations-->

- **Macro command** — A composite command that holds a list of commands and runs them in order behind a single trigger. Its undo runs them in reverse, and a failure part-way leaves the earlier steps applied unless you roll them back.
- **Undoable command** — Each command carries an `undo()` that reverses `execute()`; a [Memento](./memento.md) can capture the pre-state when reversal isn't a simple inverse.
- **Queued / deferred command** — Commands are pushed onto a queue and run later — enabling scheduling, [throttling](../../distributed/resilience/rate-limiter.md), retries, or handing work to a background worker.
- **Routed command** — A command is dispatched to whichever handler can process it, often along a [Chain of Responsibility](./chain-of-responsibility.md) — the backbone of command-bus and CQRS (Command Query Responsibility Segregation) designs.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The thing that triggers an action** and the thing that performs it never know about each other.
- **Each request becomes an object**, so you can queue it, log it, schedule it, or send it over a network.
- **Undo and redo** need a history of executed commands and an `undo()` in each one, so the cost moves to saved state and a bounded history.
- **Add a new operation as a new class**; the code that triggers it stays untouched.

### Cons
<!--meta polarity=con-->

- **One class per action** means many small types for what a single call could say.
- **Hides the real control flow** — the extra layer can hide it when you're debugging.
- **Supporting undo** forces each command to save or rebuild state, which isn't always cheap, and an effect that leaves the process (a sent email, a captured payment) cannot be undone by restoring state, so give it a compensating action or do not offer undo.
- **When your language has first-class functions**, a full command class is often overkill.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You want to hand an object** the action it should run — a menu item, button, or toolbar entry.
- **You need to queue, schedule, log, or run** operations on a remote machine.
- **You need undo/redo**, or to replay a recorded sequence of operations in order.

### Avoid when
<!--meta polarity=avoid-->

- **The action is a single call** you never store, defer, or reverse.
- **Your language has first-class functions** and you need none of the queuing, logging, or undo.
- **Choosing between algorithms** — You are picking one of several interchangeable algorithms for a job, and nothing needs the pick recorded or reversed. Use [Strategy](./strategy.md) instead.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — editor commands that carry their own undo"
interface Command { execute(): void; undo(): void }
class TextDocument {
  private text = "";
  append(chunk: string): void { this.text += chunk; }
  removeLast(count: number): void { this.text = this.text.slice(0, this.text.length - count); }
  toString(): string { return this.text; }
}
class TypeText implements Command {
  constructor(private readonly doc: TextDocument, private readonly chunk: string) {}
  execute(): void { this.doc.append(this.chunk); }
  undo(): void { this.doc.removeLast(this.chunk.length); }  // reverse exactly what we did
}

class Editor {                          // the invoker
  private readonly history: Command[] = [];
  run(cmd: Command): void {
    cmd.execute();
    this.history.push(cmd);             // remember it so we can undo
  }
  undoLast(): void { this.history.pop()?.undo(); }
}
const doc = new TextDocument();
const editor = new Editor();
editor.run(new TypeText(doc, "hello "));
editor.run(new TypeText(doc, "world"));
editor.undoLast();                      // doc is back to "hello "
```

## In the wild
<!--meta block=wild-->

- **java.lang.Runnable and java.util.concurrent.Callable** — Runnable.run() and Callable.call() turn a unit of work into an object. An ExecutorService takes a Runnable through execute() or submit() and a Callable through submit() only, queues it in its work queue and runs it on a pooled thread. Callable returns a value and may throw, both surfaced through the Future the executor hands back. {#wild-java-concurrent}
- **javax.swing.Action** — An Action extends ActionListener with bound state: an enabled flag, name, icon, and accelerator key. One instance shared by a toolbar button, a menu item, and a key binding keeps them all enabled or disabled together when setEnabled() is called. {#wild-swing-action}
- **Redux** — Each dispatched action is a plain serializable object with a type field; a pure reducer maps (state, action) to the next state. Because actions are data, the DevTools can log, replay, and time-travel through the sequence. An action holds no receiver and has no execute(); the reducer applies it, so Redux shows the call-as-data half of Command. {#wild-redux}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **History depth** — For undo/redo, how many executed commands the invoker keeps. An unbounded history grows memory for the length of the session; a capped stack drops the oldest reversible steps. Size the cap from the longest undo run a user expects times the bytes one command retains.
- **Serialization boundary** — When commands are queued, persisted, or shipped over a wire they must serialize to data. A command that captures a live receiver reference or a closure will not marshal, so carry plain data such as ids and look the receiver up when the command runs. Add a version field so commands queued before a deploy still load after it.
- **Retry limit and backoff** — How many attempts a failed queued command gets, and the delay between them, before it is parked. Without a cap a command that always fails loops forever.

### Signals to watch
<!--meta polarity=signal-->

- **Command queue depth** — For deferred or queued commands, the number waiting to run. A rising backlog means arrivals exceed the drain rate, because producers sped up or workers slowed or stalled on one failing command; check both rates.
- **Redelivery count** — How many times the same command id has run. Above one means a retry or redelivery; on a non-idempotent command that is a double effect.
- **Retained history size** — Commands and bytes the invoker keeps for undo. A count that climbs with no plateau means nothing trims it.

### Failure modes under load
<!--meta polarity=failure-->

- **Unbounded undo history** — The invoker never trims executed commands, and retained state (including the pre-state saved for undo) grows without limit.
- **Non-idempotent replay** — A queued or retried command that is not idempotent applies its effect twice when the queue redelivers or a retry fires after a partial success.

### Readiness checklist
<!--meta polarity=check-->

- Undo or command history is bounded or trimmed so it cannot grow for the life of the session.
- Commands that may be retried or redelivered are idempotent, or carry a dedup key.
- Commands that cross a queue or wire serialize cleanly, without live object references.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Event Modeling](../../../themes/event-modeling.md) — The user's intent, as its own object {#fluency-event-modeling}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Memento](./memento.md) — Command does; Memento captures state to undo
- [Chain of Responsibility](./chain-of-responsibility.md) — Commands flow along a handler chain
- [Flux](../../frontend/flux.md) — Flux actions are commands routed through a reducer
- [Mediator](./mediator.md) — Request objects give a dispatcher something uniform to route

**Often confused with**

- [Strategy](./strategy.md) — Reify an operation so it can be deferred, queued or undone vs. swap one algorithm behind a call

<!-- relationships:end -->
