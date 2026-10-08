---
title: Open/Closed Principle
description: "Open for extension, closed for modification — add behavior by adding code, not editing it"
area: principles-craft
owner: Oleksandr Derechei
tags: [low-level-design, extensibility, abstraction, polymorphism]
status: stable
aliases: [OCP]
solves: [every new payment provider means editing the same giant switch statement, I can't add a feature without touching code that already works and is tested, one more report format and I'm back in the same file adding another if-branch, adding a case forces me to re-test the whole module, shipping a new variant means redeploying the core instead of just adding to it]
---

# Open/Closed Principle

Software entities should be open for extension but closed for modification. Add new behaviour by writing new implementations of a stable abstraction, rather than reopening and re-testing code that already works.

## What it says
<!--meta block=description-->

Software entities should be open for extension but closed for modification. The phrase is Bertrand Meyer's (1988), where inheritance was the mechanism; Robert C. Martin's reading extends behaviour through new implementations of an abstraction. New behaviour arrives as new code behind a stable interface, so shipped logic stays unedited and only a thin registration point changes. It is the O in SOLID.

## Explained
<!--meta block=explain-->

The open-closed principle says you add new behaviour by writing new code, not by editing code that already works. You lay a stable interface across the one axis that varies, and each variant becomes a new implementation behind it. Without that, every new case is another branch in a growing switch, and each edit can break shipped cases. Choose it over editing in place when you can name the axis, such as payment methods or export formats, and new variants keep arriving. Choose a plain if or switch while only one variant exists, because every seam is a bet that this axis will vary, and a wrong bet costs layers of indirection and interfaces with one implementation. The counter-move is to let the hard-coded version stand and refactor to a seam once two real variants exist and a third is due, since an abstraction earned by real cases fits and a guessed one rarely does. The goal is that the next expected variant costs one new file and one registry entry, with no edit to the code that calls it.

**Example.** A shop's checkout function is an if/else ladder: card, then PayPal. Adding bank transfer means editing it, and that edit once breaks PayPal refunds. When the third method arrives, the team extracts a PaymentMethod interface with pay() and refund() and moves each branch into its own class. A fourth method, Apple Pay, now costs one new class and one registry entry, and checkout is untouched. The cost is that three branches became three classes plus an interface, and a reader follows the call through the interface to the class to see what card payment does. The team did not do this while only card existed, because one implementation would have been a bet on a variation nobody had asked for.

## Why it helps
<!--meta block=rationale-->

Code that already works and is tested is an asset; reopening it to bolt on a case puts that asset at risk. The classic shape is a `switch` over a type that grows a new arm for every variant — each edit re-touches the one function every variant shares, and a mistake made for the newest case can break all the old ones. Add a bank-transfer arm, mistype a shared variable, and card refunds that passed review last quarter now fail in production, in a function nobody meant to touch.

Push the variation behind an abstraction and new cases arrive as new classes in new files. The choice of class moves to one registration point, a map or a composition root, which you keep thin; the code that calls the interface does not change, so it does not regress. A new variant is usually lower risk than editing a shared function, provided the new class honours the interface contract.

## Applying it
<!--meta block=applying-->

Find the axis of variation and lay a seam across it:

- Program to an interface, then add capability by writing a new implementation — a new strategy, a new decorator — not a new branch.
- Replace a growing `switch` or `if`/`else` ladder over a type code with polymorphic dispatch.
- Let the stable core depend on abstractions and inject the concrete piece from outside — plugins, handlers registered at startup, a [template method](../patterns/gof/behavioral/template-method.md)'s overridable steps.
- Close only the axis that actually varies. Which one that is comes from experience with the domain, not from guessing up front.
- Review cue: flag a diff that adds a case arm, an else-if or a flag parameter to a function that already has two or more, or that edits a shipped file for every new variant. That repeat is the axis to close.

The goal: the next expected variant costs one new file and zero edits to what already ships.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a switch edited per variant, then a seam that new variants plug into"
// Before: every new payment method reopens this function.
function pay(kind: string, amount: number) {
  switch (kind) { // review smell: a switch (kind) that grows one arm per variant
    case "card": return chargeCard(amount);
    case "paypal": return chargePaypal(amount);
    // bank transfer means editing here and re-testing both arms above
    default: throw new Error(`unknown method: ${kind}`);
  }
}

// After: checkout depends on the interface; a new method is a new class.
interface PaymentMethod {
  pay(amount: number): void;
  refund(amount: number): void;
}
class Card implements PaymentMethod {
  pay(a: number) { chargeCard(a); }
  refund(a: number) { refundCard(a); }
}
class Paypal implements PaymentMethod {
  pay(a: number) { chargePaypal(a); }
  refund(a: number) { refundPaypal(a); }
}
// The one place that picks a class. Bank transfer = one new class + one entry here.
const methods: Record<string, PaymentMethod> = { card: new Card(), paypal: new Paypal() };
const checkout = (kind: string, amount: number) => {
  const m = methods[kind];
  if (!m) throw new Error(`unknown method: ${kind}`);
  m.pay(amount); // checkout is not edited when a method is added
};
```

## Taken too far
<!--meta block=overreach-->

Every abstraction is a bet that a particular axis will vary. Guess the axis wrong, or add seams for variation that never arrives, and you have paid for flexibility no one uses: layers of indirection, interfaces with a single implementation, a plugin framework for a thing that changed once. This is where the principle collides with [YAGNI](yagni.md) (you aren't gonna need it).

Do not build the extension point on speculation. Refactor once two real variants exist and a third is due, as the [Rule of Three](rule-of-three.md) says.

The false positive is a seam over code that has one variant and changes for unrelated reasons. A `PaymentMethod` interface with only `Card` behind it costs two extra files and an extra jump on every read, and buys nothing until a second method ships. The same holds when you close the wrong axis: if payments stay stable and the fee rules change weekly, the interface sits in the wrong place and every fee change still edits shipped code. Check the commit history before you pick the axis: the file that changes most often is where a seam pays. Closed covers new features only; a bug fix still edits shipped code.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Liskov Substitution Principle](./liskov-substitution.md) — Extending through new subtypes only stays safe when each is genuinely substitutable.
- [Dependency Inversion Principle](./dependency-inversion.md) — Both keep working code stable by putting an abstraction between it and what varies.
- [Strategy](../patterns/gof/behavioral/strategy.md) — Swap the algorithm by adding a new Strategy, not by editing the context.
- [Decorator](../patterns/gof/structural/decorator.md) — Add responsibilities by wrapping, leaving the wrapped class untouched.
- [Template Method](../patterns/gof/behavioral/template-method.md) — New behaviour arrives through a subclass hook; the algorithm skeleton stays closed.
- [Microkernel / Plugin](../patterns/architecture/microkernel.md) — A stable extension application programming interface (API) is the principle applied to a whole product
- [Chain of Responsibility](../patterns/gof/behavioral/chain-of-responsibility.md) — A new handler joins the chain without touching the existing ones
- [Observer](../patterns/gof/behavioral/observer.md) — Observer extends a subject by adding listeners, never by editing it.
- [You Aren't Gonna Need It (YAGNI)](./yagni.md) — A seam for an unneeded variant is the speculative generality this principle can produce.
- [Rule of Three](./rule-of-three.md) — The seam is what you extract once the repeats prove the axis.

**Specializes**

- [Design for Evolution](./design-for-evolution.md) — Open/closed is this rule at the level of a single class

**Prevents**

- [Shotgun Surgery](../hazards/shotgun-surgery.md) — Adds behaviour by adding a new class, so existing classes stay untouched

**Demonstrated by**

- [Elevator](../designs/elevator.md) — new behaviour is added by extension rather than by modifying the existing movement algorithm
- [Connect Four](../designs/connect-four.md) — Extensions arriving through new collaborators and parameters rather than rewrites is the open-closed shape
- [Logging Service](../designs/logging-service.md) — extending behaviour without modifying existing classes is open/closed made concrete
- [Rate Limiter](../designs/design-rate-limiter.md) — the design extends to new algorithms without modifying working code — open-closed made concrete

<!-- relationships:end -->
