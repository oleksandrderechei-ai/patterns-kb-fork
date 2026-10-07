---
title: ML System Design
description: "Structuring the applied-ML interview — from business objective to model, evaluation, and deep dives"
area: themes-starting
owner: Oleksandr Derechei
tags: [machine-learning, validation]
status: stable
aliases: [ML system design, applied ML interview, ML design framework]
---

# ML System Design

The delivery framework for the applied-ML system design interview: turn an ambiguous business goal into an ML system across a handful of phases, showing sound tradeoff reasoning rather than chasing a perfect design in forty-five minutes.

## The question
<!--meta block=description-->

In an interview, turn a vague prompt such as a recommendation system or a fraud detector into a working machine learning (ML) system in about 45 minutes. The goal is a structured walk with sound tradeoffs, not a perfect design. Frame the business goal before the ML objective, choose data with a reason for each signal, design the model, and evaluate against the business.

## Explained
<!--meta block=explain-->

An ML system design question gives you a vague prompt, such as a fraud detector, and 45 minutes to turn it into a working system. The method is an ordered walk with a time budget per phase, so you do not spend the whole time on a model. First frame the problem: state the business goal, then the ML objective it becomes, such as classifying a payment as fraud or ranking items. These differ, so say where. A fraud model should weigh a 5,000 payment far above a 5 one. Then sketch the whole flow, choose data signals with a reason for each, start with a simple baseline model, and only then describe a more complex one. Finish with how you will measure it. Offline metrics are cheap but may not predict real results, so confirm with an A/B test, where part of the live traffic sees the new model, on a business measure. A common failure is naming a model before framing the problem.

- **Complexity price.** A complex model costs training, serving time and upkeep, so adopt it only when its offline gain over the baseline outweighs that cost.
- **Offline gap.** Offline scores can skew live results when labels arrive late or training and serving compute features differently, so check both before you retrain.

**Example.** For a fraud detector, a 45-minute plan runs: framing 6 minutes, sketch 3, data 10, model 10, evaluation 7. That leaves 9 for deep dives such as new cardholders with no history. The business goal is cutting fraud losses while declining at most 1 in 200 good payments. The ML objective is a fraud probability weighted by amount. The baseline is logistic regression on amount, country and device age, and the next step is boosted trees, which cost more to serve. Offline you check recall at a fixed false-decline rate of 1 in 200, then an A/B test measures money lost.

## The trade-space
<!--meta block=tradespace-->

The framework runs in phases, each with a rough time budget. **Problem framing** (5–7&nbsp;min) clarifies scope and scale, establishes a business objective, and translates it into a concrete ML objective — classification, ranking, regression. Separate the two, because the ML objective is rarely the true goal. Say where they diverge: a harmful-content model should weight high-view posts far above zero-view ones, which interviewers often read as a senior signal. **High-level design** (2–3&nbsp;min) sketches inputs, components, and the action taken on outputs — usually a communication aid rather than a graded artifact.

**Data and features** (~10&nbsp;min) works from raw sources through selected features to their representation, leaning on semi- and self-supervised data beyond the obvious supervised set. Split by time, not at random, and compute features the same way in training and serving, or offline gains vanish online. **Modeling** (~10&nbsp;min) proposes a simple baseline first, then surveys candidate architectures and their tradeoffs before committing to one to detail. **Inference and evaluation** (~7&nbsp;min) covers offline metrics, A/B testing on business metrics, and serving concerns like caching, quantization, and distillation. Check an offline metric against past A/B results before you trust it, because offline metrics may not predict live results. For live tests, interleaving mixes two models' results in one list, shadow mode runs the new model beside the live one without acting on its output, and an A/B test sends part of the traffic to the new model. State the latency budget and whether scores are precomputed in batch or served online, since that bounds which model is affordable. Whatever time remains goes to **deep dives** (cold start for a new user or item with no history, scaling, and monitoring of input drift and the business metric), following the interviewer's lead.

```mermaid caption="The framework runs left to right: frame the business objective before the ML objective, sketch the lifecycle, then go deep on data, model, evaluation, and finally the problems with the biggest payoff."
flowchart LR
    PF["Problem framing (business to ML objective)"] -->|"ML objective"| HL["High-level design"]
    HL -->|"component sketch"| DF["Data and features"]
    DF -->|"feature representation"| MO["Modeling (baseline to architecture)"]
    MO -->|"chosen architecture"| IE["Inference and evaluation"]
    IE -->|"metrics and tradeoffs"| DD["Deep dives"]
```

## The concepts each phase leans on
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Feature Engineering](../patterns/ml/feature-engineering.md) {#tour-feature-engineering}

The data-and-features phase often decides the interview. Enumerate signal sources before individual features, choose an encoding per source, and name the pitfalls this problem is most exposed to: leakage (a feature that carries the answer; a time-based split helps catch it), cold start (a new user or item with no history) and drift (inputs that change over time).

### [Embeddings](../patterns/ml/embeddings.md) {#tour-embeddings}

A common way to feed high-cardinality (many distinct values) categorical, graph, and text signals into a model, and the backbone of retrieval-style architectures. Name the loss, the negatives (examples the model should score low) and the dimensionality: specifics like these read as production experience.

### [Generalization](../patterns/ml/generalization.md) {#tour-generalization}

Model capacity against available data, regularisation (a penalty that discourages overfitting), and drift: the questions behind "will this hold up in production?" Interviewers often mark down a huge model proposed on tiny data.

### [Evaluation](../patterns/ml/evaluation.md) {#tour-evaluation}

Design offline metrics that predict online results and tie back to the business objective; strong ML-metric performance with no business impact carries little weight. Each system type (classification, recommender, search, generative) needs its own evaluation strategy.

<!-- tour:end -->

## Reading the signal at each phase
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| A business objective that differs from the ML objective | State the business goal, then the ML objective, and name where they diverge | [Evaluation](../patterns/ml/evaluation.md) for the business measure; framing itself has no member |
| Inputs for the model, each with a reason | List signal sources before features, reach past supervised data to semi- or self-supervised, and split by time to catch leakage | [Feature Engineering](../patterns/ml/feature-engineering.md), [Embeddings](../patterns/ml/embeddings.md) |
| A model that holds up on the data you have | Start with a simple baseline and treat added complexity as a cost and benefit call | [Generalization](../patterns/ml/generalization.md), [Embeddings](../patterns/ml/embeddings.md) |
| An offline metric that predicts online results | Tie it to the business objective, then confirm it against an A/B result | [Evaluation](../patterns/ml/evaluation.md) |
| Offline gains that do not show up online | Check for leakage, then the training and serving feature gap, before you retrain | [Feature Engineering](../patterns/ml/feature-engineering.md), [Evaluation](../patterns/ml/evaluation.md) |
| To test a new model on live traffic | Shadow mode when you only need serving risk and latency, at the cost of serving two models; interleaving for ranking; an A/B test when the business measure must move, at the cost of live traffic and time | [Evaluation](../patterns/ml/evaluation.md) |
| Users or items with no history | Name cold start in the data step and cover it in a deep dive | [Feature Engineering](../patterns/ml/feature-engineering.md), [Generalization](../patterns/ml/generalization.md) |

## Related areas
<!--meta block=siblings-->

- [System Design Interview](./system-design-interview.md) — The software-systems sibling of this framework, for non-ML designs.
- [Harmful Content](./harmful-content.md) — The framework applied to a multi-modal content-moderation problem.
- [Bot Detection](./bot-detection.md) — The framework applied to adversarial account classification.
- [Video Recommendations](./video-recommendations.md) — The framework applied to a large-scale ranking problem.
- [GenAI at Scale](./genai-scale.md) — Scale-out patterns for the serving side of large models.
