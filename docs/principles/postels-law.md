---
title: Postel's Law
description: "Send strictly to the spec, accept anything you can read unambiguously"
area: principles-craft
owner: Oleksandr Derechei
tags: [api-design, boundaries, validation]
status: stable
aliases: [Robustness Principle]
solves: [a downstream client broke because we added one field to the response, every consumer parses our payload slightly differently and now we cannot change it, our parser quietly accepts junk from one partner and now everyone sends that junk, the integration works against the old server but not the new one and both claim to follow the spec, we relaxed a check once to unblock a partner and it is now load-bearing]
---

# Postel's Law

Be conservative in what you send and liberal in what you accept — the interoperability rule of the early internet. The liberal half is what lets two implementations evolve without a coordinated release, and also what quietly turns every tolerated deviation into part of the protocol.

## What it says
<!--meta block=description-->

Be conservative in what you do, be liberal in what you accept from others. Jon Postel wrote it into the early TCP specifications for implementers who could not coordinate: emit only what the specification plainly allows, and do not break on harmless deviations. Liberal does not mean credulous. Ignore what you do not need, such as an unknown field; do not guess at what you cannot parse, because repairing a malformed message authors a second, unwritten specification.

## Explained
<!--meta block=explain-->

Postel's law says be strict in what you send and tolerant of what you receive, so two programs written by people who never talked still work together. Send only the plain form the specification allows, since an unusual but legal encoding still breaks someone's parser. On input, ignore what you do not need, such as an unknown field or an extra header, which lets the other side add features without breaking you. Never guess at what you act on: parse it into a typed value and reject anything ambiguous with a specific error. Choose tolerance over strict rejection when you cannot coordinate with every sender. Tolerance covers only what you ignore; it never covers repairing a field you use. The rule that holds is to be strict in what you send, strict in what you act on, and liberal only about what you ignore.

- **Delayed cost.** A mistake you quietly accept is one the sender never hears about, and soon you cannot reject it. Count every anomaly you tolerate.
- **Lost fields.** Dropping unknown fields breaks pass-through, so carry them along when you forward a message.
- **Format sniffing.** Guessing the version from the content breeds a second specification, so negotiate an explicit version instead.

**Example.** A payments partner sends order events with an extra field, loyalty_tier, that your service never reads. You ignore it and keep working, so the partner can add fields freely. Then they start sending dates as 03/04/2025, which can be read two ways, while 13/04/2025 parses cleanly. Guessing could book some of those orders into the wrong month. Instead you reject those events with an error naming the date field, and a counter of rejected events shows 1,200 on the first day. The partner fixes the format in 2 days. The cost is that those 1,200 orders wait 2 days for a corrected resend.

## Why it helps
<!--meta block=rationale-->

Interoperability fails asymmetrically, and both halves of the rule exploit that. The plain, obvious form of a message is understood by every implementation, including the ones written from a partial reading of the specification. Sending conservatively therefore costs little and avoids a whole class of failures at the far end. Accepting liberally removes the mirror class: a part of the message you never read cannot be a reason to fail.

It is also what lets a protocol change without a flag day (a date when everyone upgrades at once). Across many independent implementations there is no release in which they all upgrade at once, so a change is only deployable if old readers survive new messages. Tolerance for the unrecognised turns one coordinated migration into two independent ones: producers add the field when they are ready, consumers start reading it when they are.

## Applying it
<!--meta block=applying-->

Split the rule at your boundary — strict on the way out, selective on the way in:

- Emit the plain form. One date format, no optional-but-unusual encodings, no field whose meaning you are unsure of: being unusual is legal and still breaks somebody's parser.
- Ignore what you do not consume. Unknown fields, unread headers and unused extensions should pass through your parser without an error — that tolerance is exactly what lets the other side add things.
- Validate strictly whatever you do consume. Parse it into a domain type at the boundary and reject anything ambiguous with a specific error; liberal acceptance covers the parts you skip, never the parts you act on.
- Preserve what you pass on. If you read, modify and re-emit a message, carry the unknown fields through — a component that silently strips them makes every future extension undeployable across your hop.
- Negotiate rather than sniff. An explicit version or capability field turns a guess about what the far end supports into a stated fact, and gives you a way to eventually stop accepting the old shape.
- Count what you tolerate. One metric per accepted anomaly shows that a partner has sent something wrong, while you can still ask them to fix it rather than live with a shape you can never reject.
- Review cues: flag a chain of try-parse attempts over several formats, a catch that substitutes a default for bad input, a strict decoder on a message you only forward, and tolerated input with no counter.

Strict output costs little when the spec's plain form is what your peers expect; it does mean you never use optional extensions. Tolerance on input has a delayed cost, so be as tolerant as you can be without acting on a guess.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a parser that guesses the date format, then a typed parse that ignores unknown keys and rejects the ambiguous date"
// Before: tries formats in turn and defaults on failure; 03/04 is silently read as March.
export function parseDate(s: string): Date {
  for (const f of ["MM/DD/YYYY", "DD/MM/YYYY"]) {
    const d = tryParse(s, f);
    if (d) return d;
  }
  return new Date(); // catch-and-default hides the partner's bug
}

// After: unknown keys are ignored, the date you act on is checked strictly.
export function parseOrder(raw: Record<string, unknown>): Order {
  const date = String(raw.order_date);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!m) throw new BadField("order_date", "expected DD/MM/YYYY");
  if (+m[1] <= 12 && +m[2] <= 12 && m[1] !== m[2]) {
    metrics.inc("order_date_ambiguous"); // count what you reject or tolerate
    throw new BadField("order_date", "ambiguous: " + date);
  }
  return { date: toDate(m), total: Number(raw.total) }; // loyalty_tier is ignored
}
```

## Taken too far
<!--meta block=overreach-->

Endless forgiveness is not kindness. Every mistake you quietly accept is a mistake the sender never hears about, so their bug stays in and other senders copy it — and once enough of them send the wrong thing, the wrong thing is what you can never stop accepting.

Liberal acceptance defers a cost rather than removing it. Each deviation you absorb becomes observed behaviour that some client depends on, so the working protocol grows into the union of everything every implementation has ever tolerated while the written specification stops describing the system. That union is unspecified, untested and hard to shrink: the day you tighten the parser you break traffic that works today, which is how a tolerated bug becomes a permanent feature.

The critique of the liberal half is that it trades interoperability today for ossification tomorrow. Extension points nobody exercises can become unusable, because intermediaries that have only seen the common case may reject anything else. The counter-moves are structural. Exercise every extension point continuously so intolerance surfaces early. State in the specification what a receiver must ignore, rather than leaving it to each implementer's generosity. Then measure how strict your peers actually are, so you can tighten deliberately instead of discovering the union during an outage.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Anti-Corruption Layer](../patterns/ddd/acl.md) — One layer absorbs the other side's shape, not your model
- [Message Translator](../patterns/messaging/message-translator.md) — Accept several shapes at the edge, emit one canonical form
- [Intercepting Validator](../patterns/security/intercepting-validator.md) — Strict about what you act on, liberal about what you ignore
- [Design for Evolution](./design-for-evolution.md) — Tolerance at the wire is what makes versioning survivable
- [Hyrum's Law](./hyrums-law.md) — Accepting loose input creates the very dependencies on quirks that Hyrum's Law predicts
- [API Versioning](../patterns/distributed/routing/api-versioning.md) — Tolerant readers let a version change roll out additively, but only an explicit version lets you retire the old shape.

<!-- relationships:end -->
