---
title: Feature Engineering
description: "Choosing which signals a model sees, how to encode them, and how to keep them fresh"
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, transformation, data-access]
status: stable
solves: [my model looks great offline but falls apart in production, a new user has no history so half of my features are blank, engagement rate is meaningless for an item with only a handful of views, the signal my model relies on keeps drifting and it goes stale, I do not know what else to feed the model beyond the obvious fields about the item]
---

# Feature Engineering

Deciding which signals a model gets to see and how they reach it — enumerating the sources, encoding each for a modern model, and keeping them fresh and consistent between training and serving.

## What it is
<!--meta block=description-->

A common cause of a model not learning what you want is a missing, stale or inconsistently computed input, not the architecture. Feature engineering chooses which inputs the model sees and shapes them so it can learn from them. It asks four questions: what the sources of signal are, how each is encoded, how fresh it stays, and how training and serving stay in sync.

## Explained
<!--meta block=explain-->

Feature engineering is choosing which inputs a model sees and shaping them so it can learn from them. You list the sources of signal first: the item itself, the user, their behaviour, their connections, and the context of the request. Stopping at the item alone is the common miss. Then you decide how each is encoded and how fresh it must be: fixed, recomputed in batches, streamed, or read at request time. Choose it over reaching for a bigger model when a model misses what you want, because the usual cause is a missing, stale or inconsistently computed input, not the architecture.

- **Two definitions** Behaviour signals age fast and get computed one way in training and another in serving, so define each once for both.
- **Streaming pipeline** A fast signal can quietly demand streaming, so price the freshness before you build it.
- **Leaked features** A feature holding post-prediction information looks great offline and fails live, so compute each as it was at prediction time.
- **Self-teaching** A feature recording the system's own past ranking teaches it to repeat itself, so leave it out.

**Example.** A churn model for 100,000 customers, 5,000 of whom cancelled, uses the feature tickets in the last 30 days. Training computed it on the day of export, so cancelled customers included the 30-day window around their own cancellation, when many contact support to leave. Offline the model scores 0.95 area under the curve (AUC). Live, a customer has not yet cancelled, so the spike is absent and the score drops to 0.70. Recomputing the feature as it stood 30 days before each customer's outcome gives an honest offline 0.72. The cost is a point-in-time join that makes the training query slower.

## How it works
<!--meta block=structure-->

```mermaid caption="The five sources of signal are each encoded for a model — text and images through encoders, IDs through embedding tables, sequences as tokens, numerics by log or bucket — then served through a store whose cadence runs from static, to daily batch, to streaming, to request-time. The serving cadence, not the feature list, is the real design lever."
flowchart LR
    C["Content / item"] -->|"text, images"| E["Encode"]
    A["Actor / user"] -->|"IDs"| E
    B["Behaviour"] -->|"event sequences"| E
    N["Network / graph"] -->|"graph edges"| E
    X["Context / request"] -->|"numerics"| E
    E -->|"features"| F["Feature store"]
    F -->|"serve at cadence"| M["Model"]
```

## Variations
<!--meta block=variations-->

- **Raw text and images** — Tokenize text through an encoder and patch-encode images through a vision backbone, either trained jointly with the model or fine-tuned from a pretrained backbone. Manual extraction (bag-of-words counts, colour histograms) is now rare.
- **Sparse categoricals** — Item IDs, user IDs, and enums become an embedding table — one learned vector per category, looked up by ID. For very high cardinality, the hashing trick maps IDs into a fixed bucket count, so colliding IDs share a vector: with enough buckets heavy IDs mostly stay distinct while rare IDs share buckets, and raising the bucket count limits the damage.
- **Sequences** — Lists such as recent watches or clicks are either mean-aggregated (cheap, order-free, for light rankers filtering millions of candidates) or fed as tokens through a transformer that learns temporal structure (for heavy rankers maximising quality).
- **Numeric scalars** — The one place classic feature engineering still earns its keep. Take the log of a value spanning orders of magnitude, bucket one whose effect rises and falls rather than climbing, and pull a rate measured over three views toward a prior.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Enumerating sources before individual features** gives broad, structured coverage and avoids both the blank-page freeze and the thirty-feature stream-of-consciousness dump.
- **Good signal selection often outweighs model choice** when current inputs are missing, stale or inconsistent: the right sources with a modest model can beat a sophisticated model starved of signal.
- **Narrating serving cadence** (static → batch → streaming → request-time) surfaces the infrastructure cost of each signal before it is built.
- **Naming the pitfalls a problem is exposed to** (leakage, cold start, drift, adversarial evasion) shows which failures to design against.

### Cons
<!--meta polarity=con-->

- **Behaviour signals cause most pain** — they age fast and are easy to compute two different ways.
- **A tempting fast-moving signal** can quietly demand a whole streaming pipeline; not every signal justifies the bottom tier of cadence.
- **Leaked features look excellent offline** and fail online, and the leak is often subtle enough to require squinting to spot.
- **Hand-crafted numeric features are increasingly a minority** of what feeds top-of-funnel ranking, so over-investing there can read as dated.
- **A signal that encodes the system's own past decision** — where an item was placed, how it was ranked — teaches the model to reproduce its own ordering, and it cannot be supplied at scoring time because the ordering does not exist yet.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You are designing an ML system** and must decide which inputs, encodings and cadences the model gets before any training.
- **A model performs worse in production** than offline and you suspect a missing, stale, or inconsistently-computed signal rather than the architecture.
- **A rate feature** (negatives per view, click rate) is unstable or undefined at low counts and needs smoothing or a prior.
- **A new entity has no history**, so history-dependent features are blank and need an explicit missing-value strategy.

### Avoid when
<!--meta polarity=avoid-->

- **The problem is a raw-content** task a foundation model handles end to end, where hand-crafting features adds maintenance and little else.
- **You would spend interview** or engineering time enumerating features exhaustively rather than picking the highest-impact few and moving on.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — Bayesian smoothing stabilizes a low-denominator rate feature"
// A raw rate over few observations is noise. Smooth it toward a prior:
//   smoothed = (events + alpha * C) / (trials + C)
// alpha = prior rate, C = pseudo-count the evidence has to outweigh.
function smoothedRate(events: number, trials: number, alpha = 0.02, C = 50): number {
  return (events + alpha * C) / (trials + C);
}

// 4 negatives on 8 views: raw rate 0.500, the worst in the catalogue.
smoothedRate(4, 8);        // 0.086: eight views cannot outweigh the prior
// 1800 on 9000 views: raw rate 0.200, backed by evidence.
smoothedRate(1800, 9000);  // 0.199: the evidence is there, so it stands
```

## In the wild
<!--meta block=wild-->

- **Pinterest TransActV2** — Feeds up to 16,000 lifelong user actions as a raw sequence through a self-attention transformer, rather than compressing them into hand-engineered counts — the sequence-as-tokens approach for a heavy ranker. {#wild-pinterest-transact}
- **Stripe Radar** — Scores over a thousand signals per transaction, leaning on cross-merchant, card-network-level features: having seen roughly 90% of cards before makes network-level signal outweigh one merchant's own fraud history. {#wild-stripe-radar}
- **DoorDash DashCLIP** — A CLIP-style contrastive model trained on tens of millions of query-product pairs that aligns product images, product text, and search queries into a shared embedding space, then feeds those vectors into the ranker as features. {#wild-doordash-dashclip}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Serving cadence per signal** — Static, batch-recomputed, streaming, or computed at request time. It is the single decision that fixes how much infrastructure a signal costs and how fresh it can be.
- **Freshness window or time to live (TTL)** — How stale a materialised value may be before it is recomputed, and whether a value past that age is refreshed, served anyway, or treated as missing. Work it out from how fast the signal's predictive value decays: compare score quality against input age on logged data, and alert at a fraction of that age.
- **Smoothing prior on rate signals** — The pseudo-count added to a ratio so that one click on two views does not read as a fifty percent rate. The prior strength decides how many observations it takes to move away from the population average.
- **Missing-value policy** — Per signal: an explicit default, an imputed value, or a dedicated missing indicator the model can learn from. Chosen deliberately rather than inherited from whatever the pipeline emits.
- **Backfill window** — How much history a new or changed signal is recomputed over before it can be trained on, bounded by what the source data actually retains.

### Signals to watch
<!--meta polarity=signal-->

- **Training and serving skew per signal** — The distribution of a value computed in the training pipeline against the same value logged at serving time — the direct read on whether the two code paths agree.
- **Null and default rate** — Share of scoring requests where a signal is missing or falls back to its default, split by new versus established entities.
- **Freshness lag** — Time between the source event and the computed value being readable at serving, measured per pipeline rather than in aggregate.
- **Distribution drift against the training window** — Mean, quantiles and category mix compared with the data the live model was trained on.
- **Pipeline failure and late-arrival rate** — Failed or delayed runs per source, since a silently stalled pipeline degrades scores without raising an error.

### Failure modes under load
<!--meta polarity=failure-->

- **Stale reads under a lagging pipeline** — A batch or streaming job falls behind and serving keeps reading the last written values. The model scores happily on old inputs and nothing errors.
- **Train and serve computed twice** — The same value is computed by two code paths that diverge under load or on edge cases; offline metrics stay strong while online quality drops.
- **Leakage from post-outcome data** — A value that encodes the label or something known only after the fact makes offline results look excellent and online results collapse.
- **Cold-start cliff** — A launch or import produces a wave of entities with no history, so every history-dependent value defaults at once and scores bunch together.
- **Request-time computation under pressure** — On-demand derivation adds latency at peak, and its timeouts turn into silently defaulted inputs rather than visible failures.

### Readiness checklist
<!--meta polarity=check-->

- Produce each signal from one transformation code path in training and serving, or reconcile the two with a standing skew check.
- Give every signal a documented cadence and freshness target, and alert when the lag exceeds it.
- Smooth rate signals with an explicit prior and test the low-count behaviour.
- Declare a missing-value policy per signal and exercise the cold-start path before launch.
- Enforce point-in-time correctness when assembling training sets, so no value from after the label time leaks in.
- Record an owner and a source lineage per signal, so a broken upstream can be traced quickly.
- Connect drift monitoring to the retraining decision, not only to a dashboard.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [ML System Design](../../themes/ml-system-design.md) — The data-and-features phase: enumerate sources, encode, keep train and serve in sync {#fluency-ml-system-design}
- [Harmful Content](../../themes/harmful-content.md) — Content, behavioural (age-corrected), and creator signals {#fluency-harmful-content}
- [Bot Detection](../../themes/bot-detection.md) — Activity, content, network-topology, metadata, and real-time signals {#fluency-bot-detection}
- [Video Recommendations](../../themes/video-recommendations.md) — Video and user signals, engagement normalised for age and velocity {#fluency-video-recommendations}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Embeddings](./embeddings.md) — Embeddings are the default representation for the high-cardinality and sequence signals you engineer
- [Generalization](./generalization.md) — Leakage, cold start, and drift are feature problems that wreck generalization
- [Evaluation](./evaluation.md) — Leakage and train/serve skew inflate offline metrics that vanish online

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Feature stores help keep training and serving values consistent by sharing one definition, but you still monitor skew.

<!-- relationships:end -->
