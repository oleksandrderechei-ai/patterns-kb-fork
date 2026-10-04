---
title: Mediator
description: Centralizes how a set of objects interact
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, decoupling, maintainability]
status: stable
solves: [every component holds a reference to every other component, I cannot reuse this widget anywhere because it is wired directly to five siblings, the rule for when the submit button turns on is copy-pasted across three classes, changing how two objects coordinate means editing six files, adding one more component to this screen means touching all the existing ones]
---

# Mediator

Replaces a tangle of objects calling each other directly with a single coordinator that owns how they interact — colleagues talk to the mediator, never to one another.

## What it is
<!--meta block=description-->

Objects that call each other directly form a many-to-many web, so one interaction rule is smeared across several classes and no object can be reused alone. A mediator is one hub that all the objects talk to: each tells the hub what happened, and the hub decides who reacts. The interaction logic then lives in one place.

## Explained
<!--meta block=explain-->

A mediator is one object that all the others, its colleagues, talk to instead of talking to each other. When something happens, an object tells the mediator, and the mediator decides who else reacts, so the rules for how they interact live in one place. Choose it over direct calls when those interaction rules are the hard part and are spread across many classes. Between two objects that talk one way, direct calls are simpler. The mediator must own real logic, because one that only forwards calls adds a hop and hides who triggered what.

- **God object.** Every new rule lands in the mediator, so it grows huge and hard to test. Use one mediator per feature or screen.
- **Rules in the wrong place.** A rule about a single object belongs in that object, so move it back out of the mediator.
- **Single point of failure.** A queued or networked hub caps throughput and stops everyone when it fails, so give it an error path.

**Example.** A signup form has 6 widgets. If each may call the other 5 directly, that is 30 references in the worst case. With a mediator it is 6 references from the widgets to the hub and 6 back, 12 in all. The hub holds one rule: submit is enabled only when terms is checked and email is filled. Six months later it also holds 40 rules about passwords, country lists and promo codes, and every change lands in the same class and edits collide. The fix is one mediator per section (account, address, payment) of about 14 rules each.

## How it works
<!--meta block=structure-->

```mermaid caption="Colleagues route every interaction through the mediator instead of referencing each other, collapsing a many-to-many web into a hub."
flowchart LR
    A["Colleague A"] <-->|"notify / relay"| M["Mediator"]
    B["Colleague B"] <-->|"notify / relay"| M
    C["Colleague C"] <-->|"notify / relay"| M
    D["Colleague D"] <-->|"notify / relay"| M
```

## Variations
<!--meta block=variations-->

- **Message / event bus** — The [Observer](./observer.md) end of the range: colleagues publish typed messages and subscribe to the ones they care about, so senders and receivers never name each other, though both still share the message types. It stays a mediator only while the bus owns the routing rules; with none, it is plain publish and subscribe.
- **Request dispatcher** — An in-process mediator that maps a request object to exactly one handler (the MediatR style), keeping controllers thin and handlers isolated.
- **GUI director** — The classic dialog mediator: one object owns the rules that link widgets, so each widget stays dumb about its siblings.
- **Hub / broker** — A network-scale mediator — a chat server or air-traffic controller — where clients coordinate only through the central hub, never peer-to-peer.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The objects depend on one mediator** instead of on each other, so they stay independent.
- **The rules for how they interact** live in one place, not smeared across many classes.
- **When every object calls every other**, about n(n-1) direct links become about 2n links through the hub, though the hub now depends on every colleague.
- **Each object gets simpler** and easier to reuse elsewhere.

### Cons
<!--meta polarity=con-->

- **The mediator can swell** as it soaks up every rule, until it does too much. Split it into one mediator per feature or screen.
- **In process, putting control in one place** means every rule edit lands in one class; as a queued or networked hub it also caps throughput and is a single point of failure, so give it an error path.
- **The indirection hides who actually triggers what**, making the flow harder to trace. Log request and handler names.
- **It's overkill when the objects barely interact**, or only talk one way.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A group of objects reference each other** in complex, tangled ways.
- **Reusing one object is hard** because it's wired directly to many others.
- **The rules for how they interact** are scattered across classes and hard to change.

### Avoid when
<!--meta polarity=avoid-->

- **The objects barely interact**, or only in one direction — a simple broadcast fits better.
- **There's a natural one-way flow** that needs no central coordinator.
- **The mediator would only relay calls** without owning any real logic.

Kept lean, it stops scattered coordination from congealing across your classes — but a mediator that hoards every rule becomes exactly the [God Object](../../../hazards/god-object.md) it was meant to prevent.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a signup form where one hub owns the widgets' rules"
type WidgetEvent = "toggled" | "changed";
interface Mediator { notify(sender: Component, event: WidgetEvent): void }

abstract class Component { constructor(protected readonly mediator: Mediator) {} }
class Checkbox extends Component {
  checked = false;
  toggle(): void {
    this.checked = !this.checked;
    this.mediator.notify(this, "toggled");   // tell the hub, not the button
  }
}
class TextField extends Component {
  text = "";
  type(value: string): void {
    this.text = value;
    this.mediator.notify(this, "changed");
  }
}
class SubmitButton extends Component {
  enabled = false;
  setEnabled(on: boolean): void { this.enabled = on; }
}
class SignupForm implements Mediator {
  // the hub builds its widgets, so each gets the hub at construction
  readonly terms = new Checkbox(this);
  readonly email = new TextField(this);
  readonly submit = new SubmitButton(this);

  notify(sender: Component, event: WidgetEvent): void {
    // one place owns the rule: submit needs terms checked and email filled
    if (sender === this.terms || sender === this.email) {
      this.submit.setEnabled(this.terms.checked && this.email.text !== "");
    }
  }
}
```

## In the wild
<!--meta block=wild-->

- **MediatR** — Controllers call ISender.Send(request); MediatR resolves the single IRequestHandler for that request type from the dependency injection (DI) container and invokes it, so neither side names the other. Cross-cutting concerns slot in as IPipelineBehavior wrappers that run around each request handler. INotification with Publish() is the separate multi-handler broadcast variant. {#wild-mediatr}
- **MassTransit Mediator** — The MassTransit library for .NET ships an in-process mediator, added with AddMediator, that routes a request or message to its consumer without the sender referencing the consumer. It uses the same shape as MediatR, with consumers and filters. {#wild-masstransit-mediator}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Mediator granularity** — One mediator for the whole screen or module, or several for smaller groups of colleagues. Smaller ones stay readable.
- **Sync or async dispatch** — Whether the mediator handles a request in the caller's thread or queues it. Queuing hides latency and needs an error path: say whether a failed request returns to the caller or goes to a retry store.
- **Cross-cutting hooks** — Logging, validation and transactions run around each request handler, in a fixed order. The order sets what a rejected request still triggers: with logging outermost, rejections are logged.
- **Request versus broadcast** — One handler per request, or many handlers per notification.

### Signals to watch
<!--meta polarity=signal-->

- **Mediator size** — Lines and handler count in the mediator class. Steady growth marks a new god object. In a request dispatcher, handler count follows feature count, so watch rules per handler instead.
- **Colleague imports** — Colleagues that import each other again show the mediator is being bypassed.
- **Handler count per request** — Requests with no handler or several handlers when one was expected.
- **Time in the mediator** — Latency added per dispatch, from a trace or timing.
- **Queue depth** — How many requests wait and how long the oldest has waited, when dispatch is queued.

### Failure modes under load
<!--meta polarity=failure-->

- **God object** — All the logic collects in the mediator and the colleagues become empty shells. Keep business rules in the colleagues or in handlers.
- **Missing handler found late** — A request type with no registered handler fails at run time. Check registration at startup.
- **Hidden control flow** — A call goes through the mediator and a debugger step shows nothing about who answers. Log request and handler names.
- **Cyclic dispatch** — A handler sends a request that ends up back at itself and the stack grows. Fail past a set dispatch depth and log the chain of request names.

### Readiness checklist
<!--meta polarity=check-->

- Every request type has exactly one registered handler, checked at startup; a notification may have many
- Colleagues do not import each other
- Cross-cutting hooks run in a documented order
- Handlers have tests that run without the mediator

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Route all interaction between a set of objects through one object. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Command](./command.md) — A dispatcher routes each request object to its one handler

**Often confused with**

- [Observer](./observer.md) — Broadcast changes vs. centralize interactions
- [Facade](../structural/facade.md) — Colleagues talk back through a mediator; a facade only simplifies inward

**Prevents**

- [God Object](../../../hazards/god-object.md) — Centralizing coordination, done carefully, avoids one class doing all

<!-- relationships:end -->
