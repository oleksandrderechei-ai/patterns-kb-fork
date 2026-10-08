---
title: Bot Detection
description: Separating bots from real users with a graph-sequence model behind a cheap filter
area: designs-intermediate
owner: Oleksandr Derechei
tags: [machine-learning, validation]
status: stable
aliases: [bot detection, fraud detection, abuse detection]
---

# Bot Detection

Separating genuine users from automated, malicious accounts on a social platform — an adversarial, high-prevalence, label-starved classification problem walked from business objective to a two-branch model and graduated enforcement.

## The question
<!--meta block=description-->

Bots create fake accounts, spray friend requests and messages, and spread harmful content. The task is to tell automated, malicious activity from genuine users among roughly 500 million daily actives, framed as binary classification of each account feeding an enforcement decision. Three things make it hard: bot signatures shift constantly, labels come from investigators who review only hundreds of accounts a week, and wrongly restricting a real user is expensive.

## Explained
<!--meta block=explain-->

Bot detection scores every account for the chance that it is automated and malicious, then acts on that score in steps. A cheap first model drops the obviously real accounts, which can cut the heavy model's work by roughly 80 to 90 percent at a threshold that keeps bot recall high. The heavy model looks at two things: the account's connections, which expose bots acting together, and its last 200 or so actions, which expose inhuman rhythm. Both are turned into [embeddings](../patterns/ml/embeddings.md) and [engineered features](../patterns/ml/feature-engineering.md). Judge the system by harm avoided, not by bots caught, because raw catches ignore real users wrongly restricted ([evaluation](../patterns/ml/evaluation.md)). Labels are scarce, since investigators review only hundreds of accounts a week, so learn from unlabelled data first and then fine-tune on a few thousand trusted labels. Enforcement is graduated: remove an account only when confident, and limit or demote it below that, so a wrong call stays cheap to reverse.

- **Recalibration.** Scores shift on every release, so recalibrate each time to keep removal volume steady.
- **Hidden signal.** Enforcement hides the behaviour you need to learn from, so keep a small, capped random holdout of known bots; they keep harming users.
- **Appeals.** Past the precision-recall knee, extra recall wrongly restricts more real users, who appeal; set the removal threshold inside the false-positive budget.

**Example.** The platform has 500 million daily active accounts. The cheap filter sets aside 80 to 90 percent of them, so the heavy model scores only 50 to 100 million. Investigators review perhaps 500 accounts a week, about 0.0001 percent of 500 million, which is why training leans on unlabelled data. An account with a high confidence score is removed; one with a middling score has its friend requests limited. A small random holdout of flagged bots is left running for a while, which costs some bot harm and keeps the training data honest.

## How the system is built
<!--meta block=architecture-->

A cheap **lightweight filter** (a logistic-regression model over basic signals, distilled from the heavy model) screens out the obviously legitimate accounts and passes only the survivors on, cutting compute by roughly 80 to 90 percent. Any bot the filter passes as legitimate is never scored, so tune the filter for recall on bots and measure how many it misses. The survivors go to a **two-branch model**: a **graph branch** (a GraphSAGE graph neural network (GNN) over the account's two-hop neighbourhood, which catches coordinated campaigns) and a **sequence branch** (a bidirectional GRU over the account's last ~200 events, which catches inhuman individual rhythms). A single cross-attention layer fuses the two, a multilayer perceptron (MLP) emits a risk score, a **calibration** step turns that score into a true probability, and enforcement acts on it.

Enforcement is **graduated** by confidence: full removal when the system is sure, demotion or interaction limits when it is not, to bound the damage of a wrong call. Two data hazards affect the loop: effective enforcement removes bots before they show their full behaviour (positive suppression), and the bots that survive are progressively more sophisticated (survivorship bias). Randomized holdouts mitigate both.

```mermaid caption="A cheap distilled filter screens out obviously-legitimate accounts; survivors go to a two-branch model — a GraphSAGE branch over the account's two-hop neighbourhood and a BiGRU branch over its last ~200 events — fused by cross-attention, calibrated to a true probability, then acted on with graduated enforcement."
flowchart TB
    T["Trigger: signup / activity spike / report"] -->|"account event"| F["Lightweight LR filter (distilled)"]
    F -->|"survivors (~10-20%)"| G["Graph branch (GraphSAGE, 2-hop)"]
    F -->|"survivors (~10-20%)"| S["Sequence branch (BiGRU, ~200 events)"]
    G -->|"graph embedding"| X["Cross-attention fusion + MLP"]
    S -->|"sequence embedding"| X
    X -->|"risk score"| C["Calibration (Platt scaling)"]
    C -->|"true probability"| E["Enforcement: ban / demote / limit"]
```

## The trade-space
<!--meta block=tradespace-->

The **objective** ladder rejects vanity metrics: raw detections ignore false positives, and accuracy says nothing when bots are a fraction of a percent of accounts. Constraining detection rate by a false-positive budget is workable; the strongest framing minimises the impact of bot activity on legitimate users, subject to guardrails on wrongful restriction.

The **model** choice rejects a single content-heavy model — bot detection is about behaviour, not content, and content is exactly what adversaries fake most easily. The graph-sequence approach wins because coordinated campaigns show up in the graph while individual automation shows up in the event sequence. Two ladders matter: **calibration** (histogram binning, then isotonic regression, then Platt scaling, which fits best when labelled data is scarce and the score curve is close to a sigmoid, because it has two parameters where isotonic regression needs more data) keeps enforcement volume stable across model deployments, and **anomaly detection** (isolation forests and autoencoders, best combined as an ensemble) catches the unknown-unknown bots that no labelled example covers. The same distrust applies to data your own users send: the [CamelCamelCamel](../designs/camelcamelcamel.md) case study holds each crowdsourced price report as pending until enough distinct users agree on it.

## Concepts it builds on
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Embeddings](../patterns/ml/embeddings.md) {#tour-embeddings}

The graph branch is an inductive graph neural network (GNN) (GraphSAGE) that embeds an account from its neighbourhood, so new accounts get a vector without retraining. It is pretrained self-supervised on the social graph — masking attributes and dropping edges — to tell a tight community apart from a star-shaped follow-farm.

### [Feature Engineering](../patterns/ml/feature-engineering.md) {#tour-feature-engineering}

Signals span activity patterns (posting cadence, circadian rhythm, bursts), content, network topology (follower ratios, clustering), account metadata, and real-time behaviour. Content signals are deliberately weighted lowest — they are the easiest for an adversary to fake, unlike temporal and network structure.

### [Generalization](../patterns/ml/generalization.md) {#tour-generalization}

Each branch is pretrained self-supervised on abundant unlabelled data, then fine-tuned on a few thousand trusted labels — the usual way a large model generalises when investigator labels are so scarce. Time-stratified validation guards against the drift and survivorship bias baked into an adversarial domain.

### [Evaluation](../patterns/ml/evaluation.md) {#tour-evaluation}

Offline metrics are Precision@Recall90, area under the precision-recall curve (PR-AUC), and impact-weighted variants; online tests use importance sampling to measure a sub-1% prevalence class (weight each sampled account by the inverse of its sampling probability when computing precision) without very large sample sizes, plus a maintained red-team set of sophisticated evasion patterns.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| To catch a coordinated campaign, not one account | Graph | Inductive GNN ([GraphSAGE](../patterns/ml/embeddings.md)) over the neighbourhood |
| To catch inhuman individual behaviour | Sequence | A GRU over the account's recent event stream |
| A score that maps to a real probability for enforcement | Calibration | Platt scaling over histogram binning / isotonic when labels are few |
| To catch novel bots with no labels | Unsupervised | Isolation forest + autoencoder ensemble |

## Related areas
<!--meta block=siblings-->

- [ML System Design](./ml-system-design.md) — The delivery framework this case study is an application of.
- [Harmful Content](./harmful-content.md) — The sibling trust-and-safety problem — classifying content instead of accounts.
- [Video Recommendations](./video-recommendations.md) — Shares the cheap-filter-then-heavy-model cascade, aimed at ranking.
