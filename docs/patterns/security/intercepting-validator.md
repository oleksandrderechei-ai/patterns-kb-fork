---
title: Intercepting Validator
description: Validates and sanitizes input before it reaches logic
area: security
owner: Oleksandr Derechei
tags: [security, validation, boundaries, separation-of-concerns]
status: stable
solves: [a user typed a quote character into a search box and broke everything downstream, every controller starts with twenty lines checking that fields are not empty or too long, a request with a missing field exploded deep in the domain code with a useless stack trace, we tightened a length limit on one endpoint and forgot the three others taking the same payload, people skip my nice client-side checks by calling the API directly with curl]
---

# Intercepting Validator

Places a dedicated checkpoint between untrusted input and business logic, so nothing malformed, oversized, or malicious ever reaches code that assumes the data in front of it is already clean.

## What it is
<!--meta block=description-->

An intercepting validator is a checkpoint in front of business logic that inspects every incoming request before it proceeds. Validation is split into validator objects, often one per concern, that a controller or filter invokes before dispatching. A request that fails any rule is rejected on the spot, so input that breaks a rule never reaches domain code, and the rules live in one place that is testable and auditable apart from the logic.

## Explained
<!--meta block=explain-->

An intercepting validator is a checkpoint in front of your business logic that runs a chain of rules on every incoming request and rejects bad input before any handler sees it. Form fields, query parameters, headers and uploads all come from outside your control, so a handler that trusts them is open to injected commands, oversized values and malformed data. Choose it over checks written inside each handler when many endpoints take input, because a rule added once applies everywhere and every rejection is logged in one place.

- **Per-request overhead.** Every request pays for the chain; keep rules cheap and run the quickest first.
- **Rule drift.** Rules diverge from what the logic expects, rejecting good input or passing bad; test them against the handlers they guard.
- **False safety.** Passing the gate does not make input safe downstream; still use parameterised queries and encode output.
- **Rule sprawl.** One big rule set becomes a second program of special cases; keep each rule small and separate.

**Example.** A signup form takes a username that must match 3 to 20 letters, digits or underscores. An attacker sends admin'-- hoping to cut off the rest of a login query. The validator rejects it with a 400 before any database call. A search box, however, must accept free text, quotes included, so it passes the validator. The parameterised query is what stops an injection there: the value reaches the database as data, never as part of the command. The cost appears when product decides usernames may contain a dot: you must change both the rule and the handler that assumed no dots.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does a bad field get stopped? At step 5, inside the gate, so step 6 hands business logic only input that passed every rule and no handler repeats the check; passing is not proof of safety."
flowchart LR
    Cl["Client"]:::ext
    Rules[("Rule set")]
    subgraph Gate["One choke point every request crosses"]
        F["Request filter"]
        V1["Shape and type check"]
        V2["Size and encoding check"]
    end
    BL["Business logic"]
    Cl -->|"1 request with untrusted fields"| F
    Rules -->|"2 the rules the chain enforces"| F
    F -->|"3 run the chain"| V1
    V1 -->|"4 passed, next concern"| V2
    V2 -->|"5 first failure: 4xx, nothing dispatched"| Cl
    V2 -->|"6 every rule passed"| BL
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **Programmatic validators** — Validation rules are written directly in code as a chain of validator objects, each testing one concern — presence, type, length, format — and short-circuiting on the first failure.
- **Declarative validators** — Rules are expressed as configuration or schema — annotations, a JSON Schema, an XML rule set — so non-code changes can tighten or loosen validation without a redeploy.
- **Allow-list vs. deny-list** — Validating against an allow-list of known-good shapes rejects anything unexpected, so it covers new input only as tightly as the shapes are drawn; a deny-list of known-bad patterns misses each new variant.
- **Client- and server-paired validation** — Client-side checks give fast feedback and cut round trips, but they're trivially bypassed — the server-side interceptor remains the only check that actually enforces the rule.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes validation logic** in one place instead of scattering ad hoc checks across handlers.
- **Stops malformed or malicious input** — injection payloads, oversized fields, bad encodings — before business logic ever sees it.
- **Reusable across endpoints**; a new rule is added once and applies everywhere the chain runs.
- **Gives a single point** to log and audit what was rejected, and why.

### Cons
<!--meta polarity=con-->

- **Adds a layer every request pays** for, even the vast majority that are already valid.
- **Rules can drift out** of sync with what business logic actually needs, producing false positives or false negatives.
- **Rule chain becomes a monolith** — an unmanaged chain of special cases grows into a second program unless each rule stays small and separate.
- **Passing the gate is not proof** of safety further down — it doesn't replace parameterized queries or output encoding.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Input arrives from an untrusted source** — a public API, a web form, an upload, request headers.
- **Multiple endpoints share the same validation rules** and duplicating the checks by hand is error-prone.
- **You need one enforced choke point for format**, size, and encoding rules before anything is dispatched.

### Avoid when
<!--meta polarity=avoid-->

- **The input is already fully trusted and internal**, with no crossing of a trust boundary.
- **The check needs deep business context** that only the domain logic itself can evaluate correctly.
- **A neighboring pattern already** validates the same request earlier, such as the [Gatekeeper](../distributed/routing/gatekeeper.md) or [API Gateway](../distributed/routing/api-gateway.md), and this service sits inside the same trust boundary; a service across a different boundary should still validate.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a validator chain guarding a handler"
class ValidationError extends Error {}

type Rule<T> = (input: T) => string | null; // returns an error message, or null

class ValidationChain<T> {
  constructor(private readonly rules: Rule<T>[]) {}

  run(input: T): T {
    for (const rule of this.rules) {
      const error = rule(input);
      if (error) throw new ValidationError(error); // reject on first failure
    }
    return input; // only reaches here once every rule has passed
  }
}

interface SignupRequest { email: string; age: number; }

const signupValidator = new ValidationChain<SignupRequest>([
  (r) => (r.email.length <= 254 ? null : "email too long"), // cap length before the regex runs (RFC 5321 limits an address to 254 characters)
  (r) => (/^[^@]+@[^@]+\.[^@]+$/.test(r.email) ? null : "invalid email"),
  (r) => (typeof r.age === "number" && r.age >= 13 ? null : "must be 13 or older"),
]);

function handleSignup(raw: unknown) {
  const req = signupValidator.run(raw as SignupRequest); // intercepted here; raw as SignupRequest stands in for parsing, parse raw first in real code
  return createAccount(req); // business logic never sees invalid input
}
```

## In the wild
<!--meta block=wild-->

- **Pydantic in FastAPI** — FastAPI parses each request body into a declared Pydantic model before the endpoint function runs; a mismatch raises a RequestValidationError that returns a 422 with per-field error detail. A model config of extra=forbid turns unknown fields into a rejection. {#wild-pydantic-fastapi}
- **Hibernate Validator (Bean Validation)** — The reference implementation of Jakarta Bean Validation. Constraint annotations (@NotNull, @Size, @Pattern) declared on request objects are checked at the controller boundary when the argument is marked @Valid, before the method body executes. {#wild-hibernate-validator}
- **express-validator** — Built on validator.js, it composes body()/check() validation and sanitization rules into an Express middleware chain that runs ahead of the route handler; accumulated errors are read back with validationResult(req) to reject the request. {#wild-express-validator}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Payload and field size limits** — Caps on request body size, field length, array count, and nesting depth, enforced before parsing. Too low rejects legitimate large inputs; absent, an attacker can exhaust memory or CPU with an oversized or deeply nested payload. Set each cap from the largest legitimate payload seen in logs plus headroom, and enforce it at the edge or server config as well as in the validator.
- **Allow-list vs deny-list strictness** — Whether rules accept only known-good shapes or reject known-bad patterns. Allow-listing covers unanticipated input; a deny-list covers only what its authors thought of.
- **Reject-unknown-fields mode** — Whether a payload carrying fields the schema does not declare is rejected or silently dropped. Strict rejection surfaces client drift and mass-assignment attempts; lenient mode is more forgiving but hides them.
- **Error-response verbosity** — How much a rejection tells the caller. Detailed field-level errors help legitimate clients but also hand an attacker a map of exactly what the validator expects; terse errors are safer but harder to integrate against.

### Signals to watch
<!--meta polarity=signal-->

- **Validation rejection rate** — Share of requests bounced at the gate (the 4xx/422 rate). A sudden spike is either an attack probing inputs or a validator rule that has drifted out of sync with a legitimate client change.
- **Rejections by rule / field** — Which specific rule or field is doing the rejecting. A single field dominating the rejections points at either a client contract mismatch or a targeted probe.
- **Added validation latency (p99)** — Per-request time the validator chain adds before dispatch. Watch the tail: complex regexes or large payloads show up here, and a regex under attack shows up as a latency cliff.

### Failure modes under load
<!--meta polarity=failure-->

- **Rules drift from downstream expectations** — The validator and the business logic disagree about what is valid. Too strict, it false-positives and rejects good traffic; too lax, it false-negatives and passes input the logic cannot actually handle — a false sense of safety.
- **Deny-list gap lets a payload through** — A blacklist misses a novel encoding or injection variant; malformed input clears the gate and reaches domain code, which assumed it was already checked.
- **Catastrophic regex backtracking (ReDoS)** — A validation regex with nested quantifiers hits exponential backtracking on a crafted string, pinning a CPU. The validator meant to protect the system becomes the denial-of-service vector.
- **Client-side-only reliance** — Validation is enforced in the browser for user experience (UX) but not repeated server-side; the check is trivially bypassed by calling the API directly, and the only real enforcement point is missing.

### Readiness checklist
<!--meta polarity=check-->

- Enforce every rule server-side; treat client-side validation as UX only, never as the enforcement point.
- Prefer allow-listing known-good shapes over deny-listing known-bad patterns.
- Cap payload size, field length, and nesting depth before parsing, not after.
- Confirm passing the validator does not substitute for parameterized queries and output encoding downstream.
- Review validation regexes for catastrophic backtracking on adversarial input, or bound their execution.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Auth & Access](../../themes/auth-and-access.md) — Reject bad input before it reaches logic {#fluency-auth-and-access}
- [API Design](../../themes/api-design.md) — Reject malformed and hostile input at the edge {#fluency-api-design}
- [Securing Availability](../../themes/securing-availability.md) — Stop malformed input from becoming load {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Gatekeeper](../distributed/routing/gatekeeper.md) — Screen before forwarding
- [API Gateway](../distributed/routing/api-gateway.md) — Validate input at the edge
- [Secure Logger](./secure-logger.md) — Rejections become audit records instead of vanishing
- [Chain of Responsibility](../gof/behavioral/chain-of-responsibility.md) — Chained validators are one link per concern
- [Fail Fast](../../principles/fail-fast.md) — Validating at the edge is fail-fast made concrete
- [Postel's Law](../../principles/postels-law.md) — Enforces the strict half at the point of entry
- [Quarantine](./quarantine.md) — Validates data crossing the wire; quarantine validates code crossing into the build
- [Defense in Depth](../../principles/defense-in-depth.md) — Edge validation is one layer, and does not excuse the service behind it.
- [Authorization Enforcer (RBAC)](./authorization-enforcer.md) — Once input is valid, the authorization enforcer decides what that caller may do with it.

**Implemented by**

- [Networking](../../capabilities/networking.md) — A managed web application firewall (WAF) applies rule sets to every request before it reaches the application, so the checks exist even on the endpoint whose handler forgot them.

<!-- relationships:end -->
