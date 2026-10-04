---
title: Adapter
description: Makes incompatible interfaces work together
area: gof-structural
owner: Oleksandr Derechei
tags: [low-level-design, composition, decoupling]
status: stable
aliases: [wrapper, translator]
solves: [this vendor SDK expects completely different argument shapes than the rest of my code, I cannot change the library but its method names do not match what my callers expect, third-party API details are leaking into my domain classes everywhere, I want to swap payment providers but every call site is written against the old one's signatures, my new code and this legacy module both work fine but they cannot talk to each other]
---

# Adapter

Wraps a class you can't change in the interface a client already speaks — so two components with mismatched APIs snap together without either side knowing about the other.

## What it is
<!--meta block=description-->

Calling a vendor SDK or legacy module directly spreads its method names, argument shapes and return values through every caller, and neither side can change to fit the other. An adapter is a class that implements the interface your client expects and forwards each call to the object whose interface is incompatible, translating names, argument shapes and return values. The mismatch then stops in one class, so a vendor change touches the adapter and not every caller.

## Explained
<!--meta block=explain-->

An adapter is a small class that offers the interface your code expects and translates each call into calls on an object with a different interface, such as a vendor SDK. Your code talks to the adapter only, so the vendor's names and shapes stop at one file. Choose it when you cannot change either side and the mismatch is fixed. If you own both sides, aligning the signatures once is cheaper than keeping a translator forever.

- **Lost meaning.** Where models differ in errors, timeouts or missing values, translation is lossy behind a tidy method. Write down each mapping and test it.
- **Sprawl.** One adapter per vendor is a boundary, one per class is a second codebase, so keep each thin.
- **Fat adapters.** An adapter collects business rules, which belong in your own code.

**Example.** Your app calls pay(amountCents). A vendor SDK wants charge(dollars, currency) and returns a status of ok or declined, while your code expects a call that either returns a reference or raises one payment error. The adapter converts 4,250 cents to 42.50 dollars, adds a currency, and turns a declined status into that error. A first version divides by 100 using integer division, so 4,250 cents becomes 42 dollars and 50 cents go missing. A test with 4,250 cents catches it. The cost shows later: when the vendor adds a timeout error, the adapter must map it too, or callers see an exception they have never handled.

## How it works
<!--meta block=structure-->

```mermaid caption="The client depends only on the target interface. The adapter implements that interface and delegates each call to the adaptee it wraps."
flowchart LR
    Client["Client"] -->|expects| Target["Target interface"]
    Target -.->|realized by| Adapter["Adapter"]
    Adapter -->|translates calls to| Adaptee["Adaptee, incompatible API"]
```

## Variations
<!--meta block=variations-->

- **Object adapter** — Holds the adaptee by reference and delegates through composition — flexible, and the same adapter works for any subtype of the adaptee.
- **Class adapter** — Inherits from the target and the adaptee at once, which needs multiple inheritance only when the target is a class rather than an interface. It binds tightly to one concrete adaptee, so it's rarer in practice.
- **Two-way adapter** — Implements both interfaces, so the object is usable as either type — handy when two subsystems each expect the other's shape.
- **Default (interface) adapter** — Supplies empty implementations of a wide interface so subclasses override only the few methods they care about — the shape behind Java's `MouseAdapter`.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Makes two classes with mismatched interfaces work together** — without editing either one's code.
- **Keeps all the conversion logic in one place**, so vendor quirks stop at the adapter as long as its mapping covers them.
- **Lets you reuse legacy or third-party code** behind an interface your team already knows.
- **Easy to swap**: a different backend just needs a new adapter, and calling code stays untouched.

### Cons
<!--meta polarity=con-->

- **Adds an extra class in the middle** that has to stay in step with both interfaces.
- **When the two sides differ in errors, timeouts or missing values**, the translation loses meaning behind a clean-looking method, so write down each mapping and test it.
- **Leaning on it too much** hides real design mismatches that should be fixed at the source.
- **A fat adapter tends to collect business logic** that has no place in a translator.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Plugging in a legacy class** — you need to plug in a third-party or legacy class whose interface you can't change.
- **Your code expects one shape of interface**, but the implementation you want offers a different one.
- **You want to stop vendor-specific APIs** from leaking into your own business code.

### Avoid when
<!--meta polarity=avoid-->

- **You own both sides** — just line the interfaces up directly instead of adding a translator.
- **The real problem is a whole subsystem's complexity**, not one interface — reach for a [Facade](./facade.md).
- **You need the abstraction and its implementation** to vary on their own — that's a [Bridge](./bridge.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — wrapping a mismatched payment SDK"
// The interface our checkout code already speaks: integer cents.
interface PaymentProcessor {
  pay(amountCents: number): Promise<{ readonly reference: string }>;
}

// A third-party SDK we cannot modify: it wants a dollar string and a currency.
class VendorSdk {
  async charge(dollars: string, currency: string):
    Promise<{ status: "ok" | "declined"; txnId: string }> {
    return { status: "ok", txnId: "txn_8f21" };   // a real call hits the network
  }
}

// Adapter: presents PaymentProcessor, translates, delegates to VendorSdk.
class VendorPaymentAdapter implements PaymentProcessor {
  constructor(private readonly sdk: VendorSdk) {}

  async pay(amountCents: number): Promise<{ readonly reference: string }> {
    const dollars = (amountCents / 100).toFixed(2);   // 2500 -> "25.00"
    const result = await this.sdk.charge(dollars, "usd");
    if (result.status === "declined") throw new Error("payment declined");
    return { reference: result.txnId };
  }
}

// The client depends only on the target interface, never on the vendor.
const processor: PaymentProcessor = new VendorPaymentAdapter(new VendorSdk());
const { reference } = await processor.pay(2500);
```

## In the wild
<!--meta block=wild-->

- **java.io.InputStreamReader** — Implements the character-oriented Reader over a byte-oriented InputStream; the constructor takes a Charset or charset name and an internal CharsetDecoder translates bytes to chars as they are pulled through. {#wild-java-inputstreamreader}
- **java.util.Arrays.asList** — Returns a fixed-size List view backed by the original array — set() writes through to the array, but add() and remove() throw UnsupportedOperationException because the backing store cannot resize. {#wild-arrays-aslist}
- **SLF4J** — Application code calls the SLF4J API; a binding on the classpath such as slf4j-jdk14 adapts it to the underlying logger, while bridge modules (log4j-over-slf4j, jcl-over-slf4j) adapt legacy logging APIs back onto SLF4J. {#wild-slf4j}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Object or class adapter** — Wrap an instance by composition, or subclass the adaptee. Composition works across a class that is final.
- **Direction** — One way, or both ways. Two-way adapters double the mapping code.
- **Where conversion happens** — Eagerly when data enters, or lazily on each call.
- **Error mapping** — How the adaptee's errors turn into the target interface's errors.

### Signals to watch
<!--meta polarity=signal-->

- **Adaptee types outside the adapter** — Imports of the adapted library in code that should see only the target interface.
- **Adapter latency** — Time spent in conversion, from a trace.
- **Mapping gaps** — Adaptee features the adapter drops or cannot express.
- **Adaptee version drift** — The adapted library's version has changed since the contract tests last passed.

### Failure modes under load
<!--meta polarity=failure-->

- **Leaky abstraction** — The adaptee's exceptions, types or quirks pass through the adapter, so callers still depend on it.
- **Lossy mapping** — Data is truncated or rounded on conversion with no sign.
- **Adaptee upgrade** — A new version of the adapted library changes behavior the adapter relied on.
- **Chained adapters** — An adapter wraps an adapter and a call crosses several mappings.

### Readiness checklist
<!--meta polarity=check-->

- Only the adapter imports the adapted library
- Errors from the adaptee are mapped to the target interface's errors
- A contract test runs against the adapter and its fake
- Conversions are tested at the edges of the data ranges

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Structure](../../../themes/object-structure.md) — Make an incompatible object fit the interface a client expects. {#fluency-object-structure}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Anti-Corruption Layer](../../ddd/acl.md) — Adapters implement the translation

**Part of**

- [Hexagonal](../../architecture/hexagonal.md) — Ports are filled by adapters

**Often confused with**

- [Facade](./facade.md) — Convert one interface vs. simplify many
- [Bridge](./bridge.md) — Fix a mismatch after vs. design the split up front
- [Decorator](./decorator.md) — Same wrapping shape, different intent
- [Gateway](../../enterprise/gateway.md) — Wrap an external system vs. convert an interface
- [Message Translator](../../messaging/message-translator.md) — Reshape a message vs. convert an interface
- [Proxy](./proxy.md) — Convert an interface vs. keep the same interface and control access

**Prevents**

- [Static Cling](../../../hazards/static-cling.md) — Wrapping a static third-party application programming interface (API) in an instance gives it the seam it lacked

<!-- relationships:end -->
