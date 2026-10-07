---
title: Retrieval-Augmented Generation
description: "Fetch the relevant passages first, then let the model answer from them and say so when they do not hold the answer"
area: ml
owner: Oleksandr Derechei
tags: [machine-learning, read-optimization, latency, data-access]
status: stable
aliases: [RAG, retrieval augmented generation, grounded generation]
solves: [the model answers confidently about things that are not in our documents, our assistant cannot tell us where an answer came from, our knowledge base changes weekly and retraining the model is not an option, the corpus is far too large to paste into the prompt, answers have to be limited to what this particular customer is allowed to see]
---

# Retrieval-Augmented Generation

Splits knowledge in two: what the model learned during training, and an external index built from your own corpus that is searched on every request — so the answer is grounded in passages you can name, and the corpus can change without the model changing.

## What it is
<!--meta block=description-->

A model that answers only from its trained weights cannot cite a source, and changing what it knows means training it again. Retrieval-augmented generation splits documents into passages, searches them when a question arrives, and asks the model to answer from the best matches. Each passage carries its source, and changing the corpus is an ingestion job. Retrieval quality caps answer quality.

## Explained
<!--meta block=explain-->

Retrieval-augmented generation searches your documents when a question arrives and puts the best passages into the prompt, so the model answers from current, citable text instead of only from what training stored in it. Each passage carries its source, so the answer can point to where it came from, and you fix a wrong answer by editing the document, not retraining. Ahead of time, you split documents into passages and turn each into a vector with an [embedding](embeddings.md) model. Choose it over fine-tuning, which means training the model further on your data, when the knowledge changes often, must be cited, or must stay private to some users.

- **Silent misses** A miss gives a confident wrong answer, so fetch many passages, rerank them, and answer with no document found when nothing fits.
- **Slower, longer requests** Each request pays a search and a longer prompt, so keep passages few.
- **Chunk size** Chunks too small lose context and too large blur, so split on document structure with some overlap.
- **Stale index** A stale index answers from withdrawn documents, so re-ingest or delete on every change.

**Example.** A handbook holds 10 million tokens. Splitting it into 400-token passages that overlap by 50 gives about 28,600 passages (10,000,000 divided by 350). A question searches the index, takes the top 40, and a reranker keeps 5, so the prompt grows by 5 times 400, 2,000 tokens, instead of an impossible 10 million. The answer cites passage 2. The cost lands on a Monday: the refund policy changed, and until that one document is re-ingested the index still answers from the old text.

## How it works
<!--meta block=structure-->

```mermaid caption="Where can this go wrong invisibly? Only at step 4. If the passage holding the answer is not in the top-k, steps 5 and 6 still produce a fluent, confident, wrong answer — which is why retrieval is measured on its own rather than judged through the output."
flowchart LR
    subgraph ING["Ingestion — ahead of any question"]
        D["Documents"] -->|"1 split into passages"| P["Passages"]
        P -->|"2 embed"| V[("Vector index")]
    end
    Q["Question"] -->|"3 embed, search"| V
    V -->|"4 top-k passages + sources"| A["Prompt assembly"]
    Q --> A
    A -->|"5 question + passages + 'answer from these'"| G["Generator"]
    G -->|"6 answer with citations"| U["Caller"]
```

## Variations
<!--meta block=variations-->

- **Hybrid retrieval** — Run a vector search and a keyword search, then fuse the two rankings. The standard production shape, because dense vectors are worst at exactly what users type most literally: identifiers, error codes, product names.
- **Retrieve then rerank** — Over-fetch cheaply, then score the candidates with a slower model that reads question and passage together. Often a large quality gain, since the first-stage ranking only has to get the answer into the candidate set.
- **Query rewriting** — Have the model rephrase or decompose the question before searching, so retrieval is not held to the user's wording — and a multi-part question becomes several retrievals rather than one that half-matches.
- **Metadata-filtered retrieval** — The model emits structured filters — date range, tenant, document type — alongside the semantic query, so retrieval is scoped before ranking rather than trimmed afterwards. This is also where permission scoping belongs.
- **Graph-structured retrieval** — Extract entities and relationships during ingestion and traverse them, instead of ranking passages independently. Suits questions that join several documents through known entity relations, which independent top-k ranking reaches poorly. Ingestion costs more.
- **Agentic retrieval** — The model decides whether to retrieve at all and may retrieve repeatedly as it reasons, so retrieval becomes a tool call in a loop rather than a fixed step. Better on hard questions, and unbounded in cost unless the loop is capped.
- **Per-sequence and per-token conditioning** — The original formulation lets the same retrieved passages shape the whole answer, or lets different passages shape individual tokens. Production systems almost always use the first.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Answers carry provenance**, because every retrieved passage brings its source reference with it.
- **Knowledge is updated by changing documents**, not by retraining, so a correction is live once re-ingestion finishes and the lag is measured.
- **Private and tenant-scoped corpora stay out** of model weights, so nothing is memorised that later has to be unlearned.
- **A corpus far larger** than any context window is usable, because only the selected passages are ever paid for.

### Cons
<!--meta polarity=con-->

- **Retrieval quality caps answer quality**, and a miss produces a confident wrong answer rather than an error.
- **Every request pays a retrieval** round trip plus a larger prompt, so both latency and token cost rise.
- **Chunk size is a two-sided error**: too small loses context, too large dilutes the vector.
- **An ingestion pipeline now has to be operated**, and a stale index answers confidently from withdrawn documents.
- **Changing embedding model means re-embedding the whole corpus** — a migration, not a configuration change.
- **Supplying passages reduces unsupported statements without removing them**; the model can still assert what the passages do not say.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Answers must come from a corpus** that changes faster than a model could be retrained.
- **The answer has to cite its source**, because someone will need to check it.
- **The corpus is private, tenant-scoped**, or far larger than a context window.

### Avoid when
<!--meta polarity=avoid-->

- **The whole corpus fits comfortably** in the context window — supplying it directly is simpler and cannot retrieve the wrong thing.
- **The question is a precise lookup** over structured data, where a query is exact and ranking is a guess.
- **What is missing is learned behaviour rather** than recalled facts — that is a fine-tuning problem, and retrieval will not fix it.

## Code sketch
<!--meta block=sketch-->

```python summary="Python — ingestion once, then retrieve, assemble, generate"
### ingestion — runs when documents change, not per request
def ingest(doc):
    for passage in split_on_structure(doc.text, target_tokens=400, overlap=50):
        index.upsert(
            vector=embed(passage),
            payload={"text": passage, "source": doc.url, "acl": doc.acl},
        )

### withdrawal — runs when a document is deleted or superseded
def withdraw(doc):
    index.delete(filter={"source": doc.url})

### request path
def answer(question, user):
    # Permissions filter INSIDE the query. Filtering after ranking drops the best
    # hits silently, degrading the answer instead of denying it.
    hits = index.search(
        vector=embed(question),
        filter={"acl": {"any_of": user.groups}},
        limit=40,                      # over-fetch: stage one only has to include it
    )
    hits = [h for h in rerank(question, hits) if h.score >= MIN_SCORE][:5]
    # slower model reads question + passage; MIN_SCORE is tuned on the labelled set, so weak matches drop and the abstention below can fire

    if not hits:
        return "I don't have a document covering that."

    context = "\n\n".join(f"[{i}] {h.payload['text']}" for i, h in enumerate(hits, 1))
    reply = generate(
        system="Answer only from the passages. Cite them as [n]. "
               "If they do not contain the answer, say so.",
        user=f"{context}\n\nQuestion: {question}",
    )
    return reply, [h.payload["source"] for h in hits]
```

## In the wild
<!--meta block=wild-->

- **Lewis et al., 2020** — The paper that named the architecture and defined the split between a pre-trained parametric memory and a dense vector index as non-parametric memory, along with the two conditioning formulations — one set of passages for the whole sequence, or different passages per token. {#wild-rag-paper}
- **Weaviate** — Vector database with built-in hybrid search, so dense and keyword rankings are fused inside the store rather than in application code. {#wild-weaviate}
- **pgvector** — Adds vector columns and similarity indexes to PostgreSQL, which keeps passages, their metadata and their permission rows in the same database as the rest of the application — so the permission filter is an ordinary WHERE clause. {#wild-pgvector}
- **MongoDB Atlas Vector Search** — Vector indexing alongside the operational document store, including pre-filtering on document fields so retrieval can be scoped before ranking. {#wild-atlas-vector-search}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Chunk size and overlap** — How passages are split, and how much adjacent text each one repeats. Start at 400 tokens with 50 overlap, as in the sketch, then sweep sizes and keep the one with the best recall at k on the labelled set. Too small loses context, too large dilutes the vector.
- **Retrieval depth: fetch k and rerank k** — How many candidates the cheap first stage returns and how many survive reranking into the prompt. Start near 40 fetched and 5 kept, as in the sketch. Raise fetch k until recall at k stops improving, then cut rerank k to fit the token budget. Trades tokens and latency against the chance the answer is present at all.
- **Hybrid fusion weighting** — How dense and lexical rankings are combined. Shifts behaviour between paraphrased questions and literal identifier lookups.
- **Embedding model and index parameters** — Which model produces the vectors, and the approximate-nearest-neighbour build settings that trade recall against query time. Changing the model means re-embedding the corpus.

### Signals to watch
<!--meta polarity=signal-->

- **Recall at k on a labelled question set** — How often the passage containing the answer appears in the retrieved set. The one metric that separates a retrieval problem from a generation problem.
- **End-to-end latency split by stage** — Time in embedding, vector search, reranking and generation. Tells you which stage to spend on rather than guessing.
- **Answer-with-no-citation rate** — How often the model answers without grounding in a retrieved passage. Rises when retrieval returns weak hits and the prompt does not force an abstention.
- **Index freshness lag** — Time between a document changing and its passages being re-embedded. The measure of how long the system can cite a withdrawn document.

### Failure modes under load
<!--meta polarity=failure-->

- **Confident answer from a missed passage** — The relevant passage falls outside the top k, and the model answers fluently from the ones it got. There is no error, no exception and no low-confidence signal — only a wrong answer.
- **Literal lookups retrieve badly** — A part number, error code or person name matches nothing well under pure vector similarity, so the most precise questions fail while vague ones succeed.
- **Stale index cites withdrawn documents** — A document is deleted or superseded but its passages remain in the index, so the system keeps quoting a policy that no longer applies.
- **Permission leak through retrieval** — The index returns passages the asker may not read, because filtering happens after ranking or not at all — the corpus becomes a way to read documents around the access controls.

### Readiness checklist
<!--meta polarity=check-->

- Retrieval is measured on its own, with recall at k against a labelled question set, so quality regressions are attributable to a stage.
- The permission filter is part of the query, not applied to the results after ranking.
- The prompt makes abstention an explicit option, so weak retrieval produces a refusal rather than an invention.
- Re-embedding is driven by document change rather than a periodic rebuild, and index freshness lag is measured.
- Chunking follows document structure — headings, sections, list boundaries — rather than a fixed character count.
- Retrieval combines dense and lexical search, so exact identifiers are still findable.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Harness Engineering](../../themes/harness-engineering.md) — Retrieve the relevant passages first and let the model answer only from them. {#fluency-harness-engineering}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Evaluation](./evaluation.md) — Retrieval and generation fail differently, so each needs its own metric
- [Materialized View](../distributed/coordination/materialized-view.md) — The passage index is a read model built from the corpus, and inherits exactly its staleness problem
- [Change Data Capture](../distributed/coordination/change-data-capture.md) — Driving re-embedding from a change feed is what keeps the index from citing withdrawn documents
- [AI Agent](../architecture/ai-agent.md) — The loop can call retrieval mid-task instead of only before answering
- [Context Engineering](./context-engineering.md) — The same retrieval discipline, aimed at the agent's own working corpus

**Requires**

- [Embeddings](./embeddings.md) — Passages and questions only become comparable once both are vectors from the same model

**Often confused with**

- [Agent Memory](./agent-memory.md) — This fetches passages from a corpus that already exists; that keeps what an agent learned and wrote down itself.

**Implemented by**

- [Data & Analytics](../../capabilities/data-analytics.md) — Each cloud sells the retrieval half ready-made, so you configure sources instead of building the pipeline.

<!-- relationships:end -->
