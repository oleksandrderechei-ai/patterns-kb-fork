---
title: Video Recommendations
description: Ranking billions of videos per request with staged retrieval and a multi-task ranker
area: designs-advanced
owner: Oleksandr Derechei
tags: [machine-learning, read-optimization, latency]
status: stable
aliases: [recommendation system, recsys, up next]
---

# Video Recommendations

The "up next" recommendation walked end to end: turning a watch-time-and-satisfaction goal into a multi-stage pipeline that narrows billions of candidate videos to a handful, per user, under a tight latency budget.

## The question
<!--meta block=description-->

A user is watching a video. What plays next? Scope it to the up-next slot on a YouTube-sized platform: about a billion videos, a billion daily users, five suggestions and a 250 millisecond window. The core tension is scale against latency. You cannot score a billion videos in a quarter of a second, so the system narrows aggressively before it ranks carefully, and a good candidate dropped at any narrowing stage is gone for good.

## Explained
<!--meta block=explain-->

A video recommender picks the 5 videos to play next out of about a billion in roughly 250 ms, by narrowing in stages before it ranks carefully. Many candidate generators each propose videos by looking up videos whose numeric fingerprint is close to the viewer's. A cheap model trims the pooled ten thousand or so to a few hundred. A heavy model then scores those with all the features, predicting several outcomes at once, such as watch time, like and share. A final step balances those predictions against variety, freshness and creator health. Choose this over scoring every video with one model, which is impossible in the time. It costs three things. A video dropped early is gone for good, so measure recall at each stage and add content-based generators and some random exploration for videos nobody has watched. The goal you optimise becomes the product, so pick long-term satisfaction, not clicks. And the heavy model costs compute and resists explanation, so test it live on session watch time and return rate.

**Example.** Scoring all 1 billion videos in 250 ms needs 4 billion scores a second for one viewer, so the funnel cuts first. Generators propose about 10,000 videos. The light model keeps 300. The heavy model scores those 300 and the final step picks 5. A brand-new video has no views, so a history-based generator never proposes it. A content-based generator and a small random share of exploration put it into the pool. The cost is that some of the 5 slots go to unproven videos.

## How the system is built
<!--meta block=architecture-->

The design is a multi-stage recommender. There can be hundreds of **candidate generators**. Each is a thin interface over a vector index, some universal, some personal to the viewer's history, and each proposes a pool of videos. A cheap **light ranker** optimised for recall trims the union of those pools from roughly ten thousand to a few hundred. A heavy **ranking model** then scores that short list with the full feature set and several prediction heads at once. Finally a **re-ranking** layer applies a value model that trades those predictions off against diversity, freshness, and creator health to assemble the actual slate.

The chain is one-directional: a candidate missed at generation can never be recovered downstream, so each stage's recall is measured.

```mermaid caption="Billions of videos are narrowed in stages: many two-tower (one network embeds the viewer, one embeds the video) candidate generators propose, a recall-first light ranker cuts roughly ten thousand to a few hundred, a multi-task transformer scores the survivors, and a re-ranking value model balances engagement against diversity and creator health."
flowchart LR
    Req["Request: user + context video"] -->|"seed"| CG["Candidate generation"]
    CG -->|"~10k candidates"| LR["Light ranker (GBDT)"]
    LR -->|"few hundred"| HR["Heavy ranker (transformer)"]
    HR -->|"scored shortlist"| RR["Re-ranking (value model)"]
    RR -->|"final slate"| Out["Top-5 up-next"]
```

## The trade-space
<!--meta block=tradespace-->

Two ladders shape the design: the **objective** the system optimises, and the model that scores against it. Start with the objective. Maximising click-through rate is the weak choice: it rewards clickbait thumbnails that win the click and lose the viewer. Total watch time is better and controls for that, but drifts toward addictive or merely-long content. Quality-adjusted watch time — folding in ratings, completion, and sharing — adds more. The final target is long-term satisfaction balanced across three parties: viewers, creators, and the platform, since over-optimising any one erodes the others. The [YouTube](../designs/youtube.md) case study covers the upload, transcode and streaming path around this ranker.

The second is the **model**. A plain multilayer perceptron (MLP) on concatenated features is easy but misses feature interactions and sequence. A DLRM-style architecture embeds sparse features, passes dense features through a bottom MLP and models their interactions with pairwise dot products. It does better, but still reads the history as an unordered bag. A transformer sequence ranker models the watch history directly, captures temporal intent, and is a common choice where history order matters, at a cost in compute and debuggability. Candidate generation itself is typically two-tower embeddings trained with a triplet loss and hard-negative sampling, and the heavy ranker is multi-task: separate heads (one output per outcome) for watch time, click, like, share, completion, and return-visit, which can regularise one another when the tasks are related and feed the re-ranking value model. Logged engagement reflects the slots the old ranker chose, so heads trained on it learn position as well as appeal; feed slot position as a training feature and drop it at serving.

```mermaid caption="The objective ladder: each rung fixes the previous one's failure mode, up to long-term satisfaction balanced across viewers, creators, and the platform."
flowchart LR
    CTR["Maximise click-through rate"] -->|"rewards clickbait"| WT["Total watch time"]
    WT -->|"drifts to addictive / merely-long content"| QWT["Quality-adjusted watch time"]
    QWT -->|"balance the three parties"| LTS["Long-term satisfaction: viewers, creators, platform"]
```

## Concepts it builds on
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Embeddings](../patterns/ml/embeddings.md) {#tour-embeddings}

Candidate generators are mostly two-tower embeddings: a user tower and a video tower trained so their dot product predicts engagement, with the video vectors pre-indexed so retrieval is a nearest-neighbour lookup. This is what makes proposing candidates over a billion-video catalogue tractable.

### [Feature Engineering](../patterns/ml/feature-engineering.md) {#tour-feature-engineering}

Both the context video and each candidate contribute content and engagement features; user features split into slow profile signals and fast session behaviour. Engagement counts have to be normalised for a video's age and view velocity, and features are organised by update frequency so they can be cached.

### [Evaluation](../patterns/ml/evaluation.md) {#tour-evaluation}

Each prediction head is scored on its own; the final ranking uses normalized discounted cumulative gain (NDCG), mean average precision (MAP), and diversity, while the final check is an A/B test on session watch time and return rate. The catch is the novelty effect — a new model can look good simply because it is different — so run each experiment until the lift against control stops shrinking.

### [Generalization](../patterns/ml/generalization.md) {#tour-generalization}

The hard cases are new users and videos with no behavioural history, popularity feedback loops and filter bubbles, and the explore/exploit balance between showing known-good content and surfacing something new.

<!-- tour:end -->

## When to reach for what
<!--meta block=decide-->

| If you need… | Lean | Reach for |
| --- | --- | --- |
| Billions of candidates under a tight latency budget | Multi-stage | Candidate generation + light ranker before the heavy model |
| To capture temporal intent from the watch history | Sequence model | Transformer [sequence ranker](../patterns/ml/embeddings.md) over a DLRM or MLP, when the compute and debugging cost is accepted |
| One model to serve several engagement signals | Multi-task | Shared trunk with per-signal heads feeding the value model |
| A new video with no views to get a fair chance | Cold start | Content-based candidate generation + controlled exploration |

## Related areas
<!--meta block=siblings-->

- [ML System Design](./ml-system-design.md) — The delivery framework this case study is an application of.
- [Bot Detection](./bot-detection.md) — Another applied-ML walkthrough — adversarial classification rather than ranking.
- [Harmful Content](./harmful-content.md) — Shares the multi-stage cascade and re-triggering-on-new-signals shape.
- [GenAI at Scale](./genai-scale.md) — The serving-side scale-out patterns behind large models and heavy rankers.
