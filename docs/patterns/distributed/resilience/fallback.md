---
title: Fallback
description: "Return a reduced answer — a stale copy, a default, a simpler result — when a dependency fails, so the request still succeeds"
area: distributed-resilience
owner: Oleksandr Derechei
tags: [resilience, availability, error-handling]
status: stable
aliases: [graceful degradation, degraded mode]
solves: ["the whole product page returns an error because one optional service, like recommendations, is down", "when the price service times out we show nothing, though an old price would have been fine", during a partial outage users see a blank screen where a simpler working page was possible, one failing side feature turns every response into a 500]
---

# Fallback

When a call fails, return a reduced but still useful answer — a cached copy, a default, a simpler computation — instead of an error, so the user keeps a working page with less on it.

## What it is
<!--meta block=description-->

When one optional service fails, a page that treats every failure alike returns an error although most of its answers were in hand. A fallback is a second answer written in advance: a cached copy, a default or a cheaper computation. It runs when the call fails or times out, so the caller gets a worse answer and keeps going.

## Explained
<!--meta block=explain-->

A fallback is a second answer your code returns when the first source fails, so the request succeeds with less. You wrap the call: on an error, a timeout or an open [circuit breaker](circuit-breaker.md) (a gate that stops calls to a failing service), the wrapper tries the next tier. A tier can be a cached copy, a constant, a cheaper computation such as the most popular items in place of personalised ones, or another provider. The last tier depends on no other service, so it fails only through a bug in the wrapper itself. Choose it over a plain error when part of the answer is optional or an old answer is nearly as good, because a timeout or breaker only makes a failure fast, and a fast failure is still a failure.

- **Stale can be wrong.** Cap the age of any copy and mark the response as degraded.
- **Hidden outage.** Alert on the share of responses served by a fallback.
- **Rarely run.** It runs only in incidents, so test it by breaking the primary on purpose.
- **Added load.** Keep each tier cheaper than the one above it.

**Example.** A product page calls recommendations with a 200 ms deadline, at 500 requests a second. The service goes down. Without a fallback the page treats the error as fatal, so all 500 requests a second fail. With a fallback, the wrapper reads the user's last list, kept 10 minutes. Users with no copy get a fixed list of 10 popular items. The page loads in about 210 ms (200 ms plus an assumed 10 ms cache read), the buy button works, and the response is tagged stale or default. The cost is quality: after 10 minutes the stale tier expires, so everyone sees the default list, and an alert on a rising fallback share tells you to fix it.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a request still get an answer when its dependency is down? The wrapper tries the live source at 1, and when that fails at 2 it walks down the tiers (a stale copy at 3, then a fixed default at 4), each tier depending on less than the one above and answering less faithfully, and at 5 it tells the caller which tier answered."
flowchart LR
    Caller["Request handler"]
    subgraph FB["Fallback chain — one call"]
        Live["Live source"]:::ext
        Stale[("Stale cache copy")]
        Def["Static default"]
    end
    Caller -->|"1 ask the live source"| Live
    Live -->|"2 error, timeout or open breaker"| Stale
    Stale -->|"3 copy missing or too old"| Def
    Def -->|"4 return the default"| Caller
    Stale -->|"5 or return the copy, marked degraded"| Caller
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="Where does the fallback sit? It runs only after the live call fails, it must not call the same failing dependency, and the response says which tier answered so a degraded answer is never mistaken for a fresh one."
sequenceDiagram
    autonumber
    participant H as Handler
    participant F as Fallback wrapper
    participant L as Live service
    participant C as Cache
    H->>F: get recommendations(user 42)
    F->>L: call, deadline 200 ms
    alt live answers in time
        L-->>F: personalised list
        F-->>H: list, source=live
    else error or timeout
        F->>C: read last good copy
        alt copy younger than max age
            C-->>F: stale list, age 4 min
            F-->>H: list, source=stale
        else no usable copy
            F-->>H: popular items, source=default
        end
    end
```

Walk the first diagram from the handler. The wrapper calls the live source with a deadline. A good answer goes straight back. On a failure the wrapper tries the next tier, and each tier depends on less than the one before: a cache read depends on the cache, a default depends on nothing. The response carries the tier that answered, so the caller can hide a widget, show a banner, or skip writing the answer back to a cache.

A fallback must not call the thing that just failed, or it fails for the same reason at the same moment; the last tier depends on nothing, such as a constant.

## Variations
<!--meta block=variations-->

- **Stale copy** — Serve the last good answer from a cache, with a maximum age you choose. HTTP has this built in as the `stale-if-error` cache directive. Right for data that changes slowly, such as a catalogue or a profile, and wrong for a balance or a stock level.
- **Static default** — Return a constant: an empty list, a generic image, "price on request". It has no dependency to fail and costs nothing to run. The user loses the feature, not the page.
- **Simpler computation** — Answer the same question more cheaply: popular items instead of personalised ones, a rough distance instead of a road route. It keeps the feature alive at lower quality, and it needs its own capacity.
- **Alternate source** — Ask a second provider or a read replica when the first fails. This is close to [failover](../coordination/failover.md), and the line is who decides: a fallback is a call-site choice for one request, failover moves the whole system to a standby.
- **Fail silent** — Drop the optional part of the response and say nothing. It suits a widget no user would miss, and it hides outages, so log each use.
- **Queue for later** — Accept the request, store it in a [message queue](../../messaging/message-queue.md) and finish it when the dependency returns. The user gets a receipt now and the result later, which is honest only when the result can wait.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Keeps the page working** — a failure in an optional dependency costs the user one widget, not the whole response.
- **Turns fast failure into a useful answer** — a breaker or timeout that ends in an error still fails the request, and the fallback gives it something to return.
- **Decided calmly in advance** — you pick the degraded behaviour in a design review, not at 3 a.m. under pressure.
- **Layers on other patterns** — it builds on a [circuit breaker](./circuit-breaker.md) or a [timeout](./timeout-deadline.md) you already run, but adds its own tiers, a cache and an age rule, which need tests and capacity.

### Cons
<!--meta polarity=con-->

- **A degraded answer can be a wrong answer** — a stale price shown as current can cost money, so mark degraded responses and limit the age of any copy you serve.
- **Hides outages** — if nobody sees the failure, nobody fixes it, so alert on the share of responses served from a fallback.
- **Rarely exercised, so it rots** — the fallback path runs only during incidents and breaks quietly, so test it on purpose with [fault injection](./fault-injection.md).
- **Can add load to a struggling system** — a fallback that is as costly as the primary, or that calls a shared store, spreads the overload, so keep each tier cheaper than the one above it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A dependency is optional to the page** — recommendations, ads, reviews or avatars can vanish without breaking the purchase.
- **An old answer is nearly as good as a fresh one** — a catalogue entry or a profile that changed an hour ago still serves the user.
- **Your breaker or timeout fires and then ends in a bare error** — you have already made the failure fast, and the user still sees a failed request.

### Avoid when
<!--meta polarity=avoid-->

- **A wrong answer costs more than no answer** — balances, stock for a sale or permission checks should fail instead, as [fail fast](../../../principles/fail-fast.md) argues.
- **The cause is overload, not failure** — a fallback that does extra work piles onto the overload, so refuse early with [load shedding](./load-shedding.md).
- **The request is a write that must not be lost** — a default response does not save the data, so hold it in a [message queue](../../messaging/message-queue.md) or retry with [backoff](./retry-backoff.md).

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a three-tier fallback chain: live call with a deadline, then a stale copy under a max age, then a constant"
type Tier = "live" | "stale" | "default";
type Result<T> = { value: T; tier: Tier };

const cache = new Map<string, { value: string[]; at: number }>();
const MAX_AGE_MS = 10 * 60_000;

async function recommendations(userId: string): Promise<Result<string[]>> {
  try {
    // Tier 1: the live call, cut short so a hang cannot hold the request.
    const value = await withTimeout(fetchRecommendations(userId), 200);
    cache.set(userId, { value, at: Date.now() });
    return { value, tier: "live" };
  } catch {
    // Catch only timeouts and network errors; rethrow the rest.
    // Tier 2: the last good copy, only while it is young enough to trust.
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < MAX_AGE_MS) {
      return { value: hit.value, tier: "stale" };
    }
    // Tier 3: a constant that cannot fail. The tier tells the caller it is degraded.
    return { value: ["popular-1", "popular-2", "popular-3"], tier: "default" };
  }
}
```

## In the wild
<!--meta block=wild-->

- **Netflix Hystrix** — A command class overrides `getFallback()`, which runs when the call fails, times out, is rejected or the circuit is open. The library is in maintenance mode, and its model lives on in newer libraries. {#wild-hystrix}
- **Polly (.NET)** — Ships a Fallback policy that returns a substitute value or runs a substitute action when the wrapped call throws, and it composes with the retry, timeout and circuit-breaker policies. {#wild-polly}
- **HTTP stale-if-error (RFC 5861)** — A Cache-Control extension that lets a cache serve a stale response when the origin returns an error, which is the stale-copy tier built into the protocol. {#wild-stale-if-error}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **maximum staleness** — how old a cached copy may be before the stale tier refuses to serve it; too long serves wrong data, too short empties the tier during a long outage. Start from how fast the data changes (the sketch uses 10 minutes) and shorten it once the stale copy age signal shows real use.
- **trigger conditions** — which errors, timeouts and open-breaker states send a call to the fallback; a broad trigger hides bugs, a narrow one leaves real failures as errors. Exclude client errors such as 4xx and caller bugs; the sketch's bare catch is the broad extreme, so narrow it to timeouts and network errors.
- **tier order** — the order of tiers from most to least faithful; each tier should depend on less than the one above
- **per-tier deadline** — how long each tier may take; a slow fallback delays the user as much as the failure did

### Signals to watch
<!--meta polarity=signal-->

- **fallback share** — the share of responses served by a fallback tier, per tier. This is the number to alert on: alert on a rise above that tier's normal share, and on any default-tier share for a feature that should be live.
- **stale copy age** — how old the cached copies being served are
- **fallback latency** — the latency of the fallback path against the primary path
- **fallback error rate** — a fallback that itself fails turns a degraded answer into an error

### Failure modes under load
<!--meta polarity=failure-->

- **fallback shares the failing dependency** — the fallback calls the same service or store as the primary, so it fails at the same moment and the user sees an error anyway
- **silent long-term degradation** — the primary stays broken for days, users see stale or default answers, and nothing alerts because every request succeeds
- **fallback costs more than the primary** — during an overload every request takes the heavier path, which deepens the overload
- **untested path** — the fallback has never run in production, and the first real run exposes a bug, such as an empty cache or a missing config

### Readiness checklist
<!--meta polarity=check-->

- Mark every degraded response with the tier that answered
- Alert on the share of responses served by a fallback
- Make the last tier a value that cannot fail
- Break the primary on purpose in a test and check each tier answers
- Cap the age of any stale copy, and never serve one for data where a wrong value costs money

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Resilience](../../../themes/resilience.md) — Decides what the user sees once a breaker or timeout has cut the call short {#fluency-resilience}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Circuit Breaker](./circuit-breaker.md) — A breaker that opens needs a fallback to run, or fast failure is still a failed request.
- [Timeout / Deadline](./timeout-deadline.md) — A timeout or deadline decides when the live call is abandoned and the fallback takes over.
- [Bulkhead](./bulkhead.md) — A refused bulkhead permit is one more trigger for the fallback.
- [Null Object](../../gof/extra/null-object.md) — An empty-list or no-op default is a null object; count how often it runs
- [Fault Injection](./fault-injection.md) — A fallback is unproven until a fault forces it to run.

**Alternative to**

- [Load Shedding](./load-shedding.md) — A fallback still serves a reduced answer where shedding refuses the request outright.
- [Fail Fast](../../../principles/fail-fast.md) — Fail fast returns the error where a fallback returns a lesser answer; choose fail fast when a wrong answer costs more than none.

**Often confused with**

- [Failover](../coordination/failover.md) — A fallback is a call-site choice of a lesser answer for one request.

**Prevents**

- [Cascading Failure](../../../hazards/cascading-failure.md) — A reduced answer keeps one failed dependency from failing every caller of it.

<!-- relationships:end -->
