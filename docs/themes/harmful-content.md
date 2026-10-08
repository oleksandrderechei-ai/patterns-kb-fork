---
title: Harmful Content
description: "Catching harmful posts before they're seen, without over-censoring"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [machine-learning, validation, latency]
status: stable
aliases: [content moderation, trust and safety, nsfw detection]
---

# Harmful Content

Proactively moderating harmful posts on a social network at a billion posts a day — a multi-modal, severely imbalanced classification problem walked from a views-minimising objective to a transformer classifier, a precision guardrail, and an action system.

## The question
<!--meta block=description-->

A social network wants to catch harmful text and images, from nudity and violence to terrorism, across about a billion posts a day, under 1% of them harmful. Actions come in steps: auto-remove at 95% confidence or more, demote the likely-harmful, and send borderline cases to a small human team. The objective is to minimise views of harmful content under a precision guardrail, so speed matters and posts likely to go viral are handled first.

## Explained
<!--meta block=explain-->

Harmful-content detection scores every new post for the chance that it is harmful, and again whenever reports or a jump in views arrive, then removes, demotes or sends it to people. The goal is to cut views of harmful content, not to remove the most posts, so speed counts: a harmful post gains views while it waits. About a billion posts arrive a day and under 1 percent are harmful, so the heavy model, which reads text, image and behaviour together, runs only on posts a cheap filter scores highly. Raising the filter's pass-through bar saves compute and misses more. A calibration step turns scores into true probabilities, so the business-agreed bar of 95 percent precision is held by measurement, refreshed on new labelled samples as drift erodes it: remove automatically only above it, demote below it, and give a small human team the borderline cases. Effective removal starves the training data of the behaviour it must learn, so regularly label a small random sample of live posts, whatever their score, and compare it with the model's calls.

**Example.** A billion posts a day, under 1 percent harmful, is under 10 million harmful posts a day. Running the heavy model on all billion is too costly, so the cheap filter passes only the high scorers. A post with a calibrated score of 0.95 means about 95 of 100 such posts are harmful, so removing at that level wrongly removes about 5 per 100 and the human team sees the borderline ones. A post at 0.80 is demoted instead. Later its views jump, it is re-scored with that new signal, and it crosses the bar.

## How the system is built
<!--meta block=architecture-->

A post is classified when it is created and **re-classified** as new signals arrive: reports, a jump in views, negative comments. A **cheap distilled filter** screens the easy cases; anything it scores highly escalates to a **multi-modal transformer** that scores text, image, and behavioural and user features jointly with cross-attention, where each modality reads the others. A **calibration layer** enforces the 95%-precision guardrail agreed with the business, and an **action system** removes, demotes, or routes to human review.

At a billion posts a day the transformer is too expensive to run on everything. The cascade, caching of encoder outputs for repeated images and text, and quantization make it affordable. The pass-through threshold on the light model is a tunable knob trading compute against thoroughness: choose it on a labelled sample, measuring the recall lost at each setting. Re-scoring on behaviour causes a data problem: moderation removes harmful posts before they gather views, so the surviving training data under-represents that behaviour.

```mermaid caption="Posts are classified on creation and re-classified as behavioural signals arrive: a cheap distilled filter screens the easy cases, a multi-modal transformer scores the rest jointly over text, image, and user/behavioural features, a calibration layer enforces the 95% precision guardrail, and the action system removes, demotes, or routes to human review."
flowchart LR
    P["New / updated post: text + image"] -->|"score on create"| L["Lightweight distilled filter"]
    L -->|"high score escalates"| MM["Multi-modal transformer: ViT + text + user/behavioral"]
    MM -->|"joint risk score"| Cal["Calibration: 95% precision guardrail"]
    Cal -->|"calibrated verdict"| A["Action: auto-remove / demote / human review"]
    B["Behavioral signals accrue"] -.->|"reports / views trigger re-score"| L
```

## The trade-space
<!--meta block=tradespace-->

The **objective** ladder climbs from "maximise content removed" (invites false positives) and "maximise accuracy" (meaningless under 1% prevalence) up through a precision-guardrailed removal count, to two strong framings: minimise successful user reports of harmful content, or minimise views of harmful content subject to precision. The view-based objective flows straight into the loss as a small logarithmic view-weight, so missing a high-view post is penalised without letting a viral outlier dominate training.

The **model** ladder runs from independent unimodal models (can't see that a benign image plus a caption is harmful together), through late fusion (some cross-modal signal, but only at the final layers), to a multi-modal transformer that attends across text, image, and tabular features jointly. Multi-task learning adds a second head predicting user reports, exploiting that abundant semi-supervised signal and regularising the primary task. The 95% bar holds only while calibration does: drift breaks the link between a 0.95 score and 95% precision, so recalibrate on fresh human-labelled samples.

```mermaid caption="The objective ladder: each rung fixes the one above, rising to two strong framings — the design optimises harmful views under a precision guardrail."
flowchart LR
    CR["Maximise content removed"] -->|"invites false positives"| ACC["Maximise accuracy"]
    ACC -->|"meaningless under ~1% prevalence"| PG["Removal count under a precision guardrail"]
    PG -->|"count reports, not removals"| RPT["Minimise successful user reports"]
    PG -->|"count exposure (chosen)"| VW["Minimise harmful views, subject to precision"]
```

## Concepts it builds on
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Embeddings](../patterns/ml/embeddings.md) {#tour-embeddings}

Creator risk is captured by a user embedding trained from the social graph. An inductive approach (GraphSAGE) generates a vector for a brand-new user without retraining, and the embedding is reusable across other platform applications — worth the infrastructure cost.

### [Feature Engineering](../patterns/ml/feature-engineering.md) {#tour-feature-engineering}

The most informative features are the raw text and image; behavioural signals (negative reactions, share-to-view ratio) must be corrected for post age, since a fresh post has no signal yet — Bayesian averaging stabilises those low-count ratios. Creator risk pairs a slow, rich embedding with fast real-time tallies.

### [Evaluation](../patterns/ml/evaluation.md) {#tour-evaluation}

Offline, precision-recall (PR)-area under the curve (AUC) and Recall@Precision95 (aligned to the 95% action threshold), with impression-weighted variants matching the view-based objective. Online, importance sampling makes measuring a sub-1% prevalence class affordable, and offline metrics must correlate with online results.

### [Generalization](../patterns/ml/generalization.md) {#tour-generalization}

Severe class imbalance (naive training predicts "benign" for everything and scores 99%) is handled with balanced sampling plus loss weighting. Data drift and the feedback loop of positive suppression are live risks, and the multi-task report head doubles as a regulariser.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| To catch an image that's only harmful with its caption | Multi-modal | A transformer fusing text + image with cross-attention |
| To run a heavy model at a billion posts a day | Cascade | Distilled filter + caching + quantization |
| To hold an agreed 95% precision bar | Calibration | A calibration layer to estimate it + Recall@Precision95 |
| To score creator history that shifts quickly | Slow plus fast features | A slow [user embedding](../patterns/ml/embeddings.md) + fast real-time tallies |
| To moderate one modality, or low volume | Single model | A unimodal classifier, no cascade |

## Related areas
<!--meta block=siblings-->

- [ML System Design](./ml-system-design.md) — The delivery framework this case study is an application of.
- [Bot Detection](./bot-detection.md) — The sibling trust-and-safety problem — classifying accounts instead of content.
- [Video Recommendations](./video-recommendations.md) — Shares the cheap-filter-then-heavy-model cascade, aimed at ranking.
