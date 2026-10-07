---
title: Evaluation
description: "Measuring an ML system as a stack, with offline metrics that predict online results"
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, validation]
status: stable
aliases: [offline evaluation, model metrics]
solves: [accuracy is 99% but the model is useless because positives are rare, my offline metric improved but the A/B test did not move, I do not know which metric proves this recommender is actually better, how do I measure a system whose right answer is subjective, "my model only sees the outcomes of its own past choices, so the numbers may be flattering it"]
---

# Evaluation

Measuring whether an ML system actually works — a layered stack from business objective down through product and ML metrics to methodology, where offline metrics earn their keep only by predicting online results.

## What it is
<!--meta block=description-->

A team that optimises a number disconnected from the business ships noise or harm while the dashboard reports a win. Evaluation ties the business goal to a product metric, an ML metric and the method that produces it. One average also hides failures, so you break every metric down by segment, such as new users, tail queries and each language, and gate a release on the worst one.

## Explained
<!--meta block=explain-->

Evaluation decides whether an ML system does its job, and by how much, by tracing a chain from the business goal to a product metric a user would notice, then to an ML metric you can compute on demand, then to the method that produces it. Without the chain, a team optimises a number nobody cares about: an offline gain never shows up in a live test, or the metric climbs while users leave. Choose it over reporting one headline score when positives are rare or the system serves different groups, because a single average hides the groups where it fails. Break each metric down by segment and block a release when any segment drops below its floor.

- **Moving target** Offline metrics approximate live behaviour, so check them against online results.
- **Slow labels** Labels are slow and expensive, so sample by model score when positives are rare, then weight each label by its sampling probability.
- **Self-confirming loop** A model that trains on its own decisions confirms itself, so keep a held-out set and some random traffic.
- **Human review** Generated text resists one number, so add a human review sample.

**Example.** A fraud model scores 100,000 transactions, of which 1,000 are fraud: 800 card-present and 200 online. It catches 760 card-present and 40 online, 800 in all, so overall recall is 80%. By segment, card-present recall is 760 of 800, 95%, and online recall is 40 of 200, 20%. With a floor of 70% per segment, the release is blocked on online fraud, which the 80% average hid. The cost is labelling: confirmed fraud arrives weeks later, so this check runs on last month's data.

## How it works
<!--meta block=structure-->

```mermaid caption="The evaluation stack, top to bottom. Every layer must tie back to the business objective; offline metrics matter only insofar as they predict the online result, which is why validating that correlation (the dotted loop) is the crux."
flowchart TB
    BO["Business objective"] -->|"drives"| PM["Product metrics"]
    PM -->|"proxied by"| MM["ML metrics (PR-AUC, NDCG, ...)"]
    MM -->|"measured via"| ME["Methodology: offline and online"]
    ME -->|"complicated by"| CH["Challenges: imbalance, labels, feedback loops"]
    ME -.->|"offline must predict online"| MM
```

## Variations
<!--meta block=variations-->

- **Classification** — Precision and recall at a chosen threshold, summarized by the precision-recall curve; the area under that curve (PR-AUC) reflects precision on the rare class, where the ROC curve can look high for a weak model. Set the threshold from the cost of a false alarm against a miss, or from reviewer capacity.
- **Recommenders** — Ranking metrics — NDCG, MRR, Hit@K — plus catalogue coverage and calibration, measured longitudinally over sessions rather than single impressions. Interleaving shows two rankers to the same user, so it needs less traffic than an unpaired A/B test; it ranks two rankers against each other but does not measure absolute or long-term effects.
- **Search & information retrieval** — Rank-aware metrics at a cutoff k (NDCG@k, MAP, MRR) over a graded-relevance test set, with query diversity across head, torso, and tail. Click logs carry presentation bias, so labels need debiasing via inverse-propensity weighting or interleaving.
- **Generative** — No single scalar: combine cheap-but-brittle overlap scores (BLEU, ROUGE), semantic similarity (BERTScore), task-specific fact-checkers, safety and toxicity classifiers, and periodic human preference ratings — tracking how well the automated proxies correlate with human judgement.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The stack forces every metric** to trace back to the business objective, catching the classic trap of optimizing a number users don't care about.
- **Choosing the right metric for the data** (PR-AUC over ROC-AUC under imbalance, rank-aware metrics for ranking) makes a useless model easier to spot, provided the split and slices are sound.
- **Offline evaluation gives a fast** iteration loop, and shadow mode lets a model be validated before it ever affects a user.
- **Interleaving and importance sampling** cut the traffic needed to compare rankers and the labels needed for rare classes, so measurement stays affordable; small lifts still need enough samples.

### Cons
<!--meta polarity=con-->

- **Offline metrics only approximate a moving target**; they must be continually validated against online results, and divergence between a short-term metric (click-through rate, CTR) and a long-term one (retention) signals a trap.
- **High-quality labels are expensive** and slow, and under class imbalance random sampling wastes budget and inflates variance.
- **Feedback loops let a model train** on its own echo chamber, so evaluation needs exploration traffic and a golden set unaffected by the model's own decisions.
- **Generative quality resists any single** number, so evaluation stays partly subjective and human-dependent.
- **Small slices** give noisy estimates, so report confidence intervals and set a minimum slice size before gating a release.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to prove a new model** is actually better than the current one, not just different on an offline number.
- **The positive class is rare** and accuracy is misleading, so you need PR-AUC, recall at a precision threshold, or impact-weighted metrics.
- **Designing how a system will be judged** — a recommender, search, or generative system each needs its own metric family.
- **You must connect an offline metric** to a business outcome and show the two move together before trusting the offline loop.

### Avoid when
<!--meta polarity=avoid-->

- **You would report a single headline metric** with no methodology, no challenge analysis, and no tie back to the business objective.
- **You would run an expensive** online experiment before a cheap offline proxy and shadow-mode check have ruled out the obvious regressions.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — precision, recall, and F1 from a confusion count, and why accuracy misleads"
interface Counts { tp: number; fp: number; fn: number; tn: number; }

const precision = (c: Counts) => c.tp / (c.tp + c.fp || 1); // of what we flagged, how much was right
const recall    = (c: Counts) => c.tp / (c.tp + c.fn || 1); // of all positives, how much we caught
const f1 = (c: Counts) => {
  const p = precision(c), r = recall(c);
  return (2 * p * r) / (p + r || 1);
};
const accuracy = (c: Counts) => (c.tp + c.tn) / (c.tp + c.fp + c.fn + c.tn || 1);

// A "detector" that flags nothing, on data with 1% positives:
const lazy: Counts = { tp: 0, fp: 0, fn: 100, tn: 9900 };
console.log("accuracy", accuracy(lazy).toFixed(3)); // 0.990 — looks great
console.log("recall",   recall(lazy).toFixed(3));   // 0.000 — catches nothing
// Accuracy reads 0.990 here while recall is 0.000: accuracy is fooled by imbalance.
```

## In the wild
<!--meta block=wild-->

- **scikit-learn `sklearn.metrics`** — The standard metric functions used for offline evaluation, among them `roc_auc_score`, `precision_recall_curve` and `log_loss`. {#wild-sklearn-metrics}
- **Hugging Face Evaluate** — A library of metrics and comparison tools for evaluating models behind one common interface. {#wild-hf-evaluate}
- **TensorFlow Model Analysis** — Computes evaluation metrics over slices of the data, so you can see a model's behaviour per segment as well as overall. {#wild-tfma}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Metric and decision threshold** — Which metric the team optimises and where the cutoff sits. The threshold trades precision against recall and should follow the cost of each error type.
- **Evaluation set construction** — Time-based or random split, grouping by user or item, and slices to report. A random split on time-ordered data leaks the future.
- **Offline to online link** — Which online metric the offline metric must predict, and how you check it against past experiments.
- **Refresh cadence** — How often the evaluation set is rebuilt from recent data. A frozen set stops matching production.

### Signals to watch
<!--meta polarity=signal-->

- **Offline metric per slice** — Area under the curve (AUC), precision at k or error per segment, not only the aggregate. A flat average can hide a slice that got worse.
- **Online business metric from experiments** — Click-through, conversion or retention compared between model versions, set against what offline predicted.
- **Calibration** — Whether a score of 0.8 happens about 80 percent of the time. Poor calibration breaks any threshold downstream.
- **Input and prediction drift** — Distribution of features and scores in production against training. A shift is the early sign that offline numbers have stopped applying.

### Failure modes under load
<!--meta polarity=failure-->

- **Offline win, no online gain** — The offline metric was a weak proxy for the goal. You see a better score and an unchanged business number.
- **Leakage** — Information from after the prediction time or from the same user in both splits inflates results. You see a metric too good to be true that collapses in production.
- **Aggregate hides a regression** — A model improves on average and fails a segment that matters.
- **Stale evaluation set** — Production data has moved and the fixed set still reports the old world.

### Readiness checklist
<!--meta polarity=check-->

- The split respects time and groups, so no user or item appears on both sides
- A simple baseline is reported next to the model
- Metrics are reported per slice as well as overall
- The offline metric has been compared with past experiment outcomes
- Offline and online metrics are computed by the same code

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — How you know a harness change improved anything {#fluency-harness-engineering}
- [ML System Design](../../themes/ml-system-design.md) — The inference-and-evaluation phase: offline metrics that predict online, tied to the objective {#fluency-ml-system-design}
- [Harmful Content](../../themes/harmful-content.md) — precision-recall (PR)-area under the curve (AUC) and Recall@Precision95, impression-weighted, under rare prevalence {#fluency-harmful-content}
- [Bot Detection](../../themes/bot-detection.md) — Precision@Recall90, precision-recall (PR)-area under the curve (AUC), and importance sampling under rare prevalence {#fluency-bot-detection}
- [Video Recommendations](../../themes/video-recommendations.md) — Per-head offline metrics plus NDCG/MAP, and A/B on session watch time {#fluency-video-recommendations}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Generalization](./generalization.md) — Overfitting and drift are the failure modes an evaluation strategy is built to catch
- [Embeddings](./embeddings.md) — Retrieval and ranking metrics are how embedding quality is actually measured
- [Feature Engineering](./feature-engineering.md) — An offline gain that dies online usually traces back to features
- [Retrieval-Augmented Generation](./rag.md) — A retrieval-augmented system has two stages to measure, and one score hides which broke
- [Shadow Traffic](../distributed/routing/shadow-traffic.md) — Shadow mode validates a new model on copied live requests before it affects users.

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Each cloud sells hosted scoring runs, so you supply the test set and the metrics.

<!-- relationships:end -->
