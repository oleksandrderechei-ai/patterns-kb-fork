---
title: Secure Logger
description: Records events for audit without leaking sensitive data
area: security
owner: Oleksandr Derechei
tags: [security, separation-of-concerns]
status: stable
aliases: [audit logger]
solves: [we found customer passwords sitting in plaintext in our log search tool, a stack trace dumped the whole request object including a card number, an auditor asked who opened this record back in March and I have nothing to show them, our logs ship to a third-party service and I cannot promise there are no secrets in them, anyone with database access could quietly edit the history to hide what they did]
favourite: true
---

# Secure Logger

Captures the events an audit trail needs — who did what, when — while masking or stripping the passwords, tokens, and personal data that should never survive into a log file.

## What it is
<!--meta block=description-->

A secure logger is the one component that decides what gets written down and what gets masked, so call sites stop deciding. Code hands it a structured event (actor, action, target, metadata); it applies a sensitivity policy, masks anything that must not leave the process in the clear, and writes to an append-only, access-controlled store. It closes two gaps: secrets copied verbatim into a weakly protected aggregator, and missing records of who did what.

## Explained
<!--meta block=explain-->

A secure logger is the one function every security-relevant event passes through, which takes a structured event (who, what, on which target) and masks or drops sensitive fields before anything is written. Without it, every call site decides alone what to write, and a debugging line that prints the whole request puts a password in a log that far more people can read than the database. Choose it over trusting each developer to remember, because the decision is then made once and call sites do not get a vote. Send security events down a durable path, because a buffered sink drops records under load, during an incident.

- **Allowlist upkeep.** A banned-field list misses new secrets, so allow only named fields and mask the rest; each new field must be added.
- **Lost detail.** Redaction can remove what an investigator needs; log stable ids in place of identities.
- **Bypass.** One stray console.log skips it; add a lint rule that bans it.
- **Log forging.** Outside text with line breaks can forge entries; strip control characters on the way in.

**Example.** A login handler used to run console.log(request). The request holds the password and a session token, and the log aggregator is readable by 200 engineers while the database is open to 5. After the change, the handler calls audit with userId, ip and outcome, the only three fields on its allowlist. The password is not on the allowlist, so it is masked as \[REDACTED\]. An attacker who submits the username bob followed by a line break and a fake success entry has the line break stripped, so the log shows one entry. The cost is upkeep: a new field stays invisible in logs until someone adds it. The sketch below shows the denylist form; an allowlist inverts its test.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a password typed into a login form stay out of the log aggregator? Every record reaches a sink through step 3, so masking is decided once instead of at every call site."
flowchart LR
    App["Application code"]
    subgraph Gate["One chokepoint — nothing reaches a sink unmasked"]
        SLog["Secure logger"]
        Pol[("Sensitivity policy")]
    end
    Store[("Append-only audit store")]
    Agg["Log aggregator"]:::ext
    App -->|"1 structured event: actor, action, target"| SLog
    SLog -->|"2 look up each field"| Pol
    SLog -->|"3 mask or tokenize, then append"| Store
    Store -->|"4 ship onward"| Agg
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Every event passes through the logger before any sink sees it. Fields matching the sensitivity policy are masked or redacted at write time, not cleaned up after the fact."
flowchart LR
    EV["Raw event, request, or exception"] -->|"emitted"| SL["Secure Logger"]
    SL -->|"inspect field"| CK{"Sensitive field?"}
    CK -->|"yes"| RD["Mask or redact"]
    CK -->|"no"| KEEP["Keep as-is"]
    RD -->|"redacted value"| OUT["Structured audit record"]
    KEEP -->|"raw value"| OUT
    OUT -->|"append"| STORE["Append-only, access-controlled store"]
```

## Variations
<!--meta block=variations-->

- **[Wire Tap](../messaging/wire-tap.md)** — Intercept an existing message flow with a non-invasive tap and route a copy into the secure logger, instead of instrumenting every call site by hand.
- **Allowlist vs. denylist redaction** — Denylist known-sensitive keys like password or token and mask anything matching, or allowlist only fields explicitly cleared for logging. Allowlists survive schema drift better but need active upkeep as fields are added.
- **Tokenization and hashing** — Replace an identifier with a stable hash or token instead of blanking it outright, so an investigator can still correlate events for the same user without ever seeing the raw value.
- **Tamper-evident / hash-chained entries** — Chain each entry's hash to the previous one, or sign it, so an after-the-fact edit or deletion of a log record is detectable — protecting integrity, not just confidentiality.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Centralizes masking and redaction** in one place instead of trusting every call site to remember it.
- **Gives auditors and incident responders a trail they can trust**; non-repudiation (the actor cannot later deny the action) needs the signed or hash-chained variant.
- **Lowers the risk of shipping logs to lower-trust systems**, as far as the ruleset covers the fields: security information and event management systems (SIEMs), third-party aggregators, support tools.
- **Tamper-evident variants turn the log itself** into forensic evidence, not just a debugging aid.

### Cons
<!--meta polarity=con-->

- **Adds latency and CPU** to the logging hot path — scanning and redacting nested objects isn't free.
- **A denylist can't catch** what it doesn't know about; a new field carrying a raw secret slips through silently — an allowlist inverts that, so an unknown field defaults to masked and you pay in upkeep instead of in breaches.
- **Over-aggressive redaction can strip** the very detail an investigation needed, trading audit value for false safety.
- **Only as strong as its adoption** — one stray `console.log` bypasses it entirely, which makes this a lint rule and a review habit rather than a design you can install once.
- **An asynchronous sink buys** the hot-path latency back and pays in records dropped under [backpressure](../concurrency/backpressure.md), exactly when an incident is producing them — so put security events on a durable path even where debug logs stay buffered.
- **Redaction alone leaves the inbound direction open**: values from another trust zone can carry carriage returns, line feeds, or delimiters that forge log entries, so the same chokepoint must also neutralize control characters it did not generate — structured (e.g. JSON-lines) output closes the door structurally.
- **Append-only, tamper-evident storage conflicts** with erasure duties, so keep personal data out of the trail (ids, tokens): an immutable record cannot be edited later.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You log security-relevant events** — authentication, authorization decisions, admin actions, data access.
- **Requests or domain objects carry passwords**, tokens, session IDs, or PII (personally identifiable information) that must never land in a general-purpose log store.
- **Compliance asks for an access-controlled audit trail**, often one protected from alteration; check what PCI-DSS, Health Insurance Portability and Accountability Act (HIPAA), SOC 2 or GDPR (General Data Protection Regulation) requires of you.

### Avoid when
<!--meta polarity=avoid-->

- **Nothing sensitive ever flows through the log path** — plain structured logging is enough and redaction is dead weight.
- **Logs are purely local debug output** that never leaves the developer's machine.
- **You already write to a single, encrypted**, access-controlled store — field-level redaction may be belt-and-braces.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — one door, and it masks on the way through"
// Denylist form. An allowlist inverts the test: keep only named keys, mask the rest. Nested values need the recursive redact below.
const SENSITIVE = new Set(["password", "token", "ssn", "dateofbirth"]);

// One function decides what is written down. Call sites do not get a vote.
function audit(actor: string, action: string, details: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const v = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ") : value;
    safe[key] = SENSITIVE.has(key.toLowerCase()) ? "[REDACTED]" : v;
  }
  auditStore.append(JSON.stringify({ ...safe, ts: new Date().toISOString(), actor, action }));
}

audit("user-42", "login.succeeded", { ip: "203.0.113.7", password: "hunter2" });
// written: ip is kept, password is "[REDACTED]" — the call site did not have to know

```

```typescript summary="TypeScript — an audit logger that emits references, not identities"
interface AuditEvent {
  flowId: string; personaId: string;  // safe handles stand in for who the subject is
  action: string; metadata?: Record<string, unknown>;
}

// The vault is the one place raw PII exists; a log line carrying it is a second, unguarded copy.
const SENSITIVE_KEYS = new Set(["fullname", "dateofbirth", "dob", "documentnumber", "address", "photo"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v)]));
  }
  return value;
}

class SecureLogger {
  constructor(private readonly sink: (line: string) => void) {}
  audit(event: AuditEvent): void {
    const safe = { ...event, metadata: redact(event.metadata) };
    this.sink(JSON.stringify({ ts: new Date().toISOString(), ...safe }));
  }
}

new SecureLogger(line => auditStore.append(line)).audit({ flowId, personaId,
  action: "idVendor.verified", metadata: { documentNumber: "X1234567", dob: "1984-02-11" } });
// written: documentNumber and dob are "[REDACTED]"
```

## In the wild
<!--meta block=wild-->

- **AWS CloudTrail** — Records account API activity as an append-only trail delivered to Simple Storage Service (S3). Its log file integrity validation produces hourly digest files containing SHA-256 hashes of the delivered logs, signed so that any modification or deletion of a log file after the fact is detectable. {#wild-aws-cloudtrail}
- **Pino (redact option)** — Backed by fast-redact, it takes a configured list of field paths in dot and bracket notation and replaces their values with a censor placeholder (or removes them) as the log line is serialized, so the secret never reaches the sink. {#wild-pino-redact}
- **Linux auditd** — The userspace daemon for the kernel audit subsystem: rules loaded via auditctl funnel security-relevant kernel events into an access-controlled log at /var/log/audit/audit.log, which ausearch and aureport then query for forensic review. {#wild-linux-auditd}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Redaction ruleset (allowlist vs denylist field paths)** — The set of field paths masked before a record is written — a denylist names what to hide, an allowlist names what may be shown.
- **Event selection / audit level** — Which events are captured as security audit records rather than ordinary debug logs, which sets both what an investigation can reconstruct and how much store you pay for.
- **Retention period** — How long audit records are kept before expiry, usually set by a compliance regime (PCI-DSS, HIPAA, SOC 2) rather than by you.
- **Sink write mode (sync vs async buffering)** — Whether records are written synchronously or buffered and flushed asynchronously — the hot-path latency of the logger against the durability of the trail.
- **Integrity mechanism** — Whether entries are hash-chained or signed so a later edit or deletion is detectable, and how often the chain is anchored.

### Signals to watch
<!--meta polarity=signal-->

- **Logging hot-path latency / CPU** — Cost the logger adds per event — worth watching where high event rates meet deep object graphs, since that is where redaction is most expensive.
- **Audit-log ingestion rate / volume** — Records written per unit time. A spike can be an attack, a runaway loop or log flooding; a drop toward zero usually means the audit path broke without saying so.
- **Dropped / queued log events** — Depth of the buffer feeding the sink and any drop count — gaps here are gaps in the trail.
- **Redaction match rate** — How often the ruleset actually masks a field. A drop can mean a renamed or newly added field is now going through in the clear.

### Failure modes under load
<!--meta polarity=failure-->

- **Denylist gap leaks a secret** — A new field carrying a raw token or PII is not on the denylist and is written verbatim into an aggregator far less protected than the source system. This is how plaintext secrets end up in a SIEM.
- **Bypass via stray console.log or stack trace** — Code logs a request object or dumps an exception outside the secure logger, so the policy never runs and sensitive fields land in the clear.
- **Sink backpressure drops audit records** — Under load the sink cannot keep up and the buffer overflows, so security events are discarded precisely when the trail matters most and non-repudiation quietly stops holding.
- **Over-aggressive redaction destroys evidence** — A too-broad rule masks the identifiers or context an investigation needed, leaving a trail that is safe and useless.
- **Forged entries from injected control characters** — An untrusted value carrying carriage returns or line feeds writes what reads as an additional log line, so the record an investigator trusts was authored by the attacker.

### Readiness checklist
<!--meta polarity=check-->

- The ruleset was tested against a real log line for a field added since it was written, not only against the fields it already knew
- The audit sink is append-only and access-controlled — at least as protected as the system it records
- The codebase was searched for log calls that bypass the logger, and the search is repeatable rather than a one-off
- Retention matches the governing compliance requirement, and someone can say which requirement that is
- Where integrity is required, tamper-evidence was verified by altering a record and seeing the check fail
- Security events sit on a durable path whose behaviour under backpressure is blocking or alerting, not silent discard

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Observability](../../themes/observability.md) — Audit without leaking secrets {#fluency-observability}
- [Health Modeling](../../themes/health-modeling.md) — Log generously without creating a compliance incident {#fluency-health-modeling}
- [Securing Availability](../../themes/securing-availability.md) — Keep the record without creating a second incident {#fluency-securing-availability}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Wire Tap](../messaging/wire-tap.md) — Tap to an audit log
- [Intercepting Validator](./intercepting-validator.md) — A rejected request is an event worth recording
- [Single Access Point](./single-access-point.md) — One entry point is where the audit trail can be complete
- [Design for Operations](../../principles/design-for-operations.md) — Operable logging is logging that is safe to keep and to share
- [Backpressure](../concurrency/backpressure.md) — When the sink overflows, backpressure drops records; security events need a durable path beneath it.

**Demonstrated by**

- [Persona Identification & Sanction Check](../../designs/persona-identification.md) — redacting raw personally identifiable information (PII) from every log line in a persona-verification saga, emitting flowId/personaId references instead
- [Persona Identification & Sanction Check (V2)](../../designs/persona-identification-v2.md) — a case study whose log lines carry only flow and person ids, never raw personal data, so the log is no second copy of the vault

**Implemented by**

- [Observability Platform](../../capabilities/observability-platform.md) — Managed collectors ship redaction and masking as pipeline configuration
- [Identity & Access](../../capabilities/identity.md) — CloudTrail, the Azure activity log and Cloud Audit Logs record every control-plane call, with integrity validation that makes a later deletion detectable.

<!-- relationships:end -->
