---
title: Shadow Traffic
description: Copy live requests to a new version and discard its answers
area: distributed-routing
owner: Oleksandr Derechei
tags: [routing, testability]
status: stable
aliases: [traffic mirroring, request mirroring, traffic shadowing]
solves: [a release passed every test but I am afraid it will break on real production requests, I need to compare a rewritten service with the old one on real requests without users seeing it, staging never shows the request shapes and load that production sends, testing the new version on live traffic would show users errors if it is wrong]
---

# Shadow Traffic

Shadow traffic copies live requests to a second version of a service, lets it process them for real, and throws its responses away, so the new version meets production load while no user depends on it.

## What it is
<!--meta block=description-->

A staging environment never sees the request shapes, volume or odd data that production does, so a release that passed every test can still fall over on day one. Shadow traffic duplicates each real request at the router and sends the copy to the new version. The user gets the old version's answer, and the new version's answer is dropped or compared. A crash or a slow query shows up with no user hurt.

## Explained
<!--meta block=explain-->

Shadow traffic duplicates each live request at the router and sends the copy to a new version, which processes it for real while its response is thrown away or compared offline with the old version's. The user is answered by the old version alone, so the new version meets real payloads, volume and bad data with nobody exposed to it. Choose it over a [canary release](./canary-release.md) when no user may see a failure, and over a staging test when the request mix is the unknown. A canary is the next step, because only live responses show what users do with them. The hazard is side effects, since a copy that writes or charges does it twice.

- **Duplicated side effects.** A shadow that writes, emails or charges acts twice; give it sandboxed dependencies and block non-idempotent calls.
- **Extra load.** Every mirrored request costs the shadow a full request; sample a share, or size the shadow like production.
- **Noisy diffs.** Ids and timestamps differ by design; normalise them before you read a diff as a bug.

**Example.** A team replaces a search service and mirrors 10 percent of 2,000 requests per second, so the shadow takes 200 per second. Over an hour it sees 720,000 requests and returns an error on 0.4 percent of requests the old version answered correctly, all with one rare filter combination, so they fix it before any user sees it. The p99 is 180 ms against 120 ms for the old, indicative only: the shadow runs a test index at a tenth of the load. The cost is a shadow sized for 200 requests per second, and a test index so it never writes to the live one.

## How it works
<!--meta block=structure-->

```mermaid caption="Where does the copy go? Step 2 duplicates the request after the router has already committed to the primary, so the user path is unchanged. Step 5 discards the shadow response, or diffs it offline."
flowchart LR
    Cl["Client"]:::ext
    subgraph Router["Router or proxy"]
        Mir["Mirror"]
    end
    Prim["Primary v1"]
    Shad["Shadow v2"]
    Cmp[("Comparison store")]
    Cl -->|"1 request"| Mir
    Mir -->|"2 forward"| Prim
    Prim -->|"3 response to client"| Cl
    Mir -.->|"4 copy, fire and forget"| Shad
    Shad -.->|"5 response discarded or diffed"| Cmp
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What can the shadow break? Nothing the user waits for. If the shadow is slow or down, the client has already been answered, and the mirror should give up on the copy after its own timeout."
sequenceDiagram
    autonumber
    participant C as Client
    participant R as Router
    participant P as Primary v1
    participant S as Shadow v2
    C->>R: request
    R->>P: forward
    R-)S: mirrored copy
    P-->>R: response
    R-->>C: response
    S--)R: response, dropped
    Note over S: crash or slow, no effect on C
```

The mirror sits at a router, proxy or [service mesh](./service-mesh.md). It sends the copy after, or in parallel with, the primary call and never waits for it.

The hard part is side effects. A shadow that writes to the real database, sends the real email or charges the real card does it a second time. Point the shadow at its own data store or sandboxed dependencies, and make non-idempotent calls fail closed (reject them rather than run them). To judge correctness, record both responses and diff them offline, ignoring fields that differ by design such as timestamps and ids.

## Variations
<!--meta block=variations-->

- **Proxy mirroring** — A proxy or mesh duplicates requests by rule, so no application code changes. The copy usually carries a marker header so the shadow knows it is a copy.
- **Response diffing** — Both responses are stored and compared, so a wrong answer shows up as a diff and not only a crash. Normalise fields that differ by design or the diff drowns in noise.
- **Sampled shadowing** — Mirror a fixed share of requests, such as 5 percent, to bound the extra load. A rare request shape may then never be seen.
- **Replay from a log** — Capture requests, then replay them against the new version later, at any speed. It allows load tests at several times production rate, but state and time-dependent requests may no longer make sense.
- **Message copy** — At a messaging layer, a [wire tap](../../messaging/wire-tap.md) copies messages to a side channel for a shadow consumer. The same idea, applied to messages instead of requests.
- **Diverging state** — A shadow on its own data store drifts from production, so reads differ and the diff reports false regressions. Seed it from a snapshot, or replicate production writes into it.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Zero user exposure** — the shadow answer is never returned, so a crash or wrong result is not served; side effects and data copies still need isolation.
- **Real traffic shape** — real payloads, volume and odd data reach the new version, which a test suite cannot invent.
- **Finds latency and crash regressions before launch** — you see p99 and error rate on the new version under real load, if the shadow has production-like capacity and data; a sample shows p99 only at the sample rate.
- **No change to the primary path** — the copy never delays the user's answer; a shadow sharing a database or cache with the primary can still slow it, so isolate them.

### Cons
<!--meta polarity=con-->

- **Duplicated side effects** — a shadow that writes, emails or charges does it twice. Use sandboxed dependencies and block non-idempotent calls.
- **Extra load** — every mirrored request costs the shadow and its dependencies a full request. Sample, or size the shadow like production.
- **Cannot judge what users do with answers** — a user never acts on the shadow response, so engagement and conversion stay unknown. Follow with a [canary release](./canary-release.md).
- **Needs a diff you can trust** — responses differ by design in ids and timestamps. Normalise them first, or you chase noise.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A rewrite must match the old behaviour** — you are replacing a service or a query engine and want to compare outputs on real requests.
- **A performance change is at stake** — a new database, cache or runtime must show its latency under real load.
- **Even a small share of users cannot be exposed** — the cost of a visible failure is higher than the cost of a mirror.

### Avoid when
<!--meta polarity=avoid-->

- **Requests have side effects you cannot isolate** — payments, emails and notifications would run twice.
- **Requests carry personal data the shadow may not hold** — copying them extends the data's reach.
- **The old service is already near capacity** — a mirror adds copying work, and any shared database or cache load, to the primary path.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — answer from the primary, mirror a sample to the shadow, never wait for it"
type Handler = (req: Request) => Promise<Response>;

function withShadow(primary: Handler, shadow: Handler, sampleRate = 0.05): Handler {
  return async (req) => {
    const copy = Math.random() < sampleRate ? req.clone() : null;   // clone before the body is read
    const res = await primary(req);                                 // the user's answer comes from v1

    if (copy) {
      copy.headers.set("x-shadow", "1");                            // the shadow can refuse side effects
      const kept = res.clone();                                     // the user path consumes res, so keep a copy for the diff
      void shadow(copy)                                             // fire and forget
        .then((s) => record(kept, s))                                // diff offline, never returned
        .catch(() => {});                                           // a failing shadow is invisible
    }
    return res;
  };
}

declare function record(primary: Response, shadow: Response): void;
```

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Continuous Validation](../../../themes/continuous-validation.md) — Copy live requests to a new version and discard its replies to test it safely. {#fluency-continuous-validation}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Service Mesh](./service-mesh.md) — Mesh proxies can duplicate requests by rule, with no application change
- [Wire Tap](../../messaging/wire-tap.md) — Message-layer sibling: copies messages to a side channel for a shadow consumer
- [Evaluation](../../ml/evaluation.md) — Offline evaluation sets the metrics and floors that a shadow run's output is judged against.

**Variant of**

- [Canary Release](./canary-release.md) — A canary exposes a slice of users, so it can judge responses users act on

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A mesh can mirror live requests to a candidate version without the caller seeing its answer.

<!-- relationships:end -->
