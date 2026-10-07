---
title: Embeddings
description: Learned dense vectors that place similar entities close together
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, transformation, read-optimization]
status: stable
aliases: [vector embeddings, embedding vectors]
solves: [keyword search misses obvious near-matches because the words do not overlap, I have ten million product ids and one column per id blows up my model, I need the most similar items out of a huge catalogue in milliseconds, my model treats every id as unrelated and learns nothing from lookalikes, I want to group users by how alike they are without defining the categories first]
---

# Embeddings

Represents entities as learned dense vectors in a shared space where nearness means similarity — so a model generalizes across related items instead of memorizing each one, and the closest candidates to a query can be retrieved fast.

## What it is
<!--meta block=description-->

One-hot encoding gives each of millions of users or items its own column, so the model learns each one alone and a new entity has nothing. An embedding replaces each with a short learned vector, typically 64 to 1024 numbers, so similar entities sit close together. The training objective decides what similar means. Knowledge then carries across entities, and distances and averages become meaningful.

## Explained
<!--meta block=explain-->

An embedding replaces an id, such as a user, a video or a word, with a short list of learned numbers, typically 64 to 1024 of them, arranged so that things that behave alike get nearby lists. You train it by picking a notion of similarity, starting from random numbers and nudging pairs that should match closer and pairs that should not further apart. Enough nudges make the space settle into clusters without anyone naming categories. Choose it over one-hot encoding, which gives every id its own column, when you have millions of ids: one-hot makes the model learn each id alone, while embeddings share structure between similar ones and let you find nearest neighbours fast.

- **Narrow meaning** Similar means only what your training pairs made it mean, so choose pairs that match the goal.
- **Cold start** A new item with no interactions has no useful vector, so start it from its title and attributes.
- **Width tuning** Too few numbers lose structure, too many cost storage and search time, so tune against a downstream metric.
- **Ageing vectors** Vectors age as behaviour shifts, so retrain or re-embed on a schedule.

**Example.** A video service has 10 million users. One-hot input gives each user a 10-million-wide vector with one 1 in it. A 64-number embedding stores 64 numbers at 4 bytes each, 256 bytes per user, so the whole table is 10,000,000 times 256 bytes, 2.56 GB. Two users who watch the same late-night videos end up near each other, so a model that learned from one can serve the other. The cost shows on launch day: a new video has no watch history, so its vector comes from its title and tags until about a week of watches arrives to retrain it.

## How it works
<!--meta block=structure-->

```mermaid caption="The two-tower retrieval shape. Both towers output into one shared vector space, so a dot product between a query vector and an item vector is a match score. Candidate vectors are computed offline and pre-indexed, so at serve time only the query tower runs and nearest-neighbour lookup returns the top-k."
flowchart LR
    U["User / query"] -->|"encode online"| UT["Query tower"]
    I["Item / candidate"] -->|"encode offline"| IT["Item tower"]
    UT -->|"output"| QV["query vector"]
    IT -->|"output"| IV["item vector"]
    QV -->|"compare"| S["dot product / cosine"]
    IV -->|"pre-indexed"| S
    S -->|"top-k"| ANN["ANN retrieval"]
```

## Variations
<!--meta block=variations-->

- **Matrix factorization** — Factor an interaction matrix (users × items) into two thin matrices, users × k and items × k, so their product reconstructs the observed cells. Forcing each entity through only k numbers makes the decomposition discover shared behavioural patterns; the similarity comes from that low-rank compression, not from explicit pairwise nudges. Cheap, well-understood, and still a common retrieval baseline via ALS or SGD.
- **Two-tower / contrastive learning** — Separate encoders for the query side and the candidate side output into the same space; train on positive and negative pairs, using the other rows of a batch as free "in-batch negatives" and a loss such as Triplet loss or InfoNCE. Candidates are pre-embedded into an index and only the query tower runs online; with an approximate index over those vectors, that is what makes retrieval over billions of items fast.
- **Graph embeddings** — For relational data, such as who follows whom or what is bought together. Transductive methods (node2vec, DeepWalk) run random walks and a word2vec-style objective to learn one vector per node in the training graph, but a new node has no vector until you retrain. Inductive methods (GraphSAGE and most graph neural networks (GNNs)) learn a function that computes a node's vector from its features and neighbourhood, so new nodes get embeddings at inference, provided they arrive with usable features or neighbours.
- **Pre-trained, then fine-tuned** — When a model already trained on a huge general corpus (BERT, CLIP, sentence-transformers) encodes most of the structure you need, start from it and fine-tune on task-specific data instead of training from scratch. The cheapest path to a usable space, and the first to try.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Compact per entity** — one short vector replaces a column per id, so the model input width stays fixed, though table storage still grows with entity count (2.56 GB for ten million at 64 floats).
- **Enables fast similarity search**: pre-index candidates once and retrieve nearest neighbours over huge catalogues with only the lightweight query encoder running online.
- **Transferable** — a vector trained for one task (say, recommendations) can be handed to a neighbouring team as a ready-made input feature.
- **Inductive and content-based setups** can represent a brand-new entity from its attributes, without waiting for a retrain.

### Cons
<!--meta polarity=con-->

- **"Similar" means only what the training objective** made it mean — co-watch closeness is not conceptual similarity.
- **Purely behavioural vectors are useless** for a new entity with no interactions until a content-based embedding is blended in.
- **Dimensionality is a real tradeoff** — higher costs more to train, store, and search; too low loses structure — so it has to be tuned per use case.
- **Hard to evaluate directly**; only downstream metrics judge quality. Mining hard negatives and keeping vectors fresh adds infrastructure work.
- **Version lock** — a new model makes old vectors incomparable, so re-embed and re-index every candidate and roll the query side out with them.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need to represent high-cardinality categorical entities** — millions of user or item IDs — without a separate column per value.
- **You need the most similar items** to a query, fast, over a very large candidate set — retrieval, semantic search, or the retrieval step of a retrieval-augmented generation (RAG) pipeline.
- **You want to carry knowledge across tasks** by feeding a rich learned representation into a downstream model instead of hand-crafted features.
- **You want to cluster or segment entities** by proximity — user segmentation, topic discovery, near-duplicate detection.

### Avoid when
<!--meta polarity=avoid-->

- **The inputs are few in number** or already numeric — an embedding just adds cost.
- **You cannot define a meaningful notion** of similarity, or you lack the interaction or pair data to train one.
- **Matching must be exact, interpretable, and auditable** — a learned vector space is opaque, and at scale its nearest-neighbour search is approximate.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — two-tower retrieval: cosine similarity and top-k over a candidate set"
type Vec = number[];

const dot = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i], 0);
const cosine = (a: Vec, b: Vec) =>
  dot(a, b) / (Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)) || 1);

// Item vectors come from the item tower, indexed offline.
const catalog = [
  { id: "sci-fi-epic", vec: [0.9, 0.1, 0.2] },
  { id: "true-crime",  vec: [0.2, 0.2, 0.9] },
];

// At serve time only the query tower runs.
const user: Vec = [0.85, 0.15, 0.25];

catalog
  .map((it) => ({ id: it.id, score: cosine(user, it.vec) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 1);   // → sci-fi-epic
// A real catalogue replaces this linear scan with an approximate index.
```

## In the wild
<!--meta block=wild-->

- **CLIP** — Trains an image encoder and a text encoder so a matching image and caption land close in one shared space — the archetypal two-tower contrastive setup, and a common source of pre-trained vectors. {#wild-clip}
- **SimCSE** — A contrastive method for sentence embeddings whose unsupervised variant builds a positive pair by encoding the same sentence twice under different dropout masks, pulling those two views together against the other sentences in the batch as negatives. {#wild-simcse}
- **sentence-transformers** — An open-source library packaging pre-trained transformer encoders that output sentence-level vectors usable out of the box for semantic search and clustering — the fine-tune-a-pre-trained-encoder path in practice. {#wild-sentence-transformers}
- **ByteDance Monolith** — TikTok's recommendation system built around a parameter server whose embedding tables update online as interactions arrive, so vectors adapt to fresh behaviour far faster than a nightly batch re-embedding job could. {#wild-monolith}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Vector dimensionality** — The width of the learned vector. Higher retains more structure and costs more to train, store and search; too low collapses distinctions. Tune it per catalogue and task.
- **Similarity metric** — Cosine, dot product or Euclidean distance. It has to match the objective the vectors were trained under, and the index must be built for the same metric.
- **Approximate index build and search parameters** — Graph-based indexes expose a build-time neighbour count and a query-time candidate breadth; partition-based ones expose how many partitions a query probes. Both trade recall against latency and memory. Sweep each parameter against exact search on a sampled query set and keep the cheapest setting that meets your target recall at k.
- **Refresh cadence** — How often changed and newly created entities are re-embedded, and whether the index is rebuilt wholesale or updated incrementally.
- **Encoder batch size and placement** — Batch size and hardware for the offline embedding job, and whether the query encoder runs in-process or as a separate service.

### Signals to watch
<!--meta polarity=signal-->

- **Approximate recall against exact search** — Recall at k for the served index measured against a brute-force scan on a sampled set of queries — the only direct read on how much the approximation costs. Set the floor from the downstream metric (the lowest recall where it stays flat) and alert on a drop from the launch baseline.
- **Nearest-neighbour query latency percentiles** — p50 and p99 for the retrieval step, separate from the encoder, so an index regression is not hidden by model time.
- **Index freshness lag** — Time between an entity changing and its new vector being searchable.
- **Share of requests with no vector** — Fraction of queries or candidates falling back because the entity has never been embedded.
- **Downstream task metric** — Click-through, conversion or retrieval hit rate — vector quality cannot be read off the vectors themselves, so the downstream number is the real signal.

### Failure modes under load
<!--meta polarity=failure-->

- **Rebuild outruns its window** — Index build time grows with the catalogue until rebuilds queue behind each other and served vectors drift steadily further out of date.
- **Memory exhaustion** — Dimensionality times entity count times index overhead exceeds resident memory; the index spills and query latency collapses.
- **Silent recall decay** — A search parameter tightened for latency degrades result quality while every latency dashboard stays green — nothing in the serving path notices worse neighbours.
- **Cold entities after a bulk import** — A launch adds entities faster than the embedding job runs, so they are invisible to retrieval until it catches up.
- **Mixed model versions in one index** — Vectors from an old and a retrained model share an index, and distances between them stop meaning anything.

### Readiness checklist
<!--meta polarity=check-->

- Measure recall at k against exact search before launch, and re-measure whenever index parameters change.
- Version the model and the index together: one index holds vectors from exactly one encoder version, and cutover is atomic.
- Define the cold-start path for entities with no interaction history — attribute-based vectors or an explicit fallback ranker.
- Know the full rebuild time and confirm it fits inside the freshness target with headroom for catalogue growth.
- Size resident memory from dimensionality, entity count and index overhead, with a plan for the next order of magnitude.
- Wire up a downstream metric, since quality cannot be judged from the vectors alone.
- Confirm the query-time similarity metric is the one the vectors were trained and indexed under.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [ML System Design](../../themes/ml-system-design.md) — The default representation for categorical, graph, and text signals {#fluency-ml-system-design}
- [Harmful Content](../../themes/harmful-content.md) — Inductive user embeddings capture creator risk, reusable across the platform {#fluency-harmful-content}
- [Bot Detection](../../themes/bot-detection.md) — Inductive graph embeddings place an account by its network position {#fluency-bot-detection}
- [Video Recommendations](../../themes/video-recommendations.md) — Two-tower embeddings drive candidate generation and approximate nearest neighbour (ANN) retrieval {#fluency-video-recommendations}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Feature Engineering](./feature-engineering.md) — Feature engineering decides which signals get embedded and how they are encoded
- [Evaluation](./evaluation.md) — Embeddings are judged by downstream metrics like recall@k, not their training loss alone
- [Generalization](./generalization.md) — Shared structure lets learning transfer to rare and unseen entities
- [Agent Memory](./agent-memory.md) — Indexing distilled facts is what lets recall scale past the window

**Enables**

- [Retrieval-Augmented Generation](./rag.md) — The retrieval step of a retrieval-augmented generation (RAG) pipeline is the most common reason to build an embedding index

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Every cloud sells the vector index, so you do not run the similarity search yourself.
- [Search engines](../../comparisons/search-engines.md) — Which search engine can hold and query your embeddings.

<!-- relationships:end -->
