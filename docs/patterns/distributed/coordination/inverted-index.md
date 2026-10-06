---
title: Inverted Index
description: "Maps each term to the documents that contain it, so text search reads a short list instead of scanning every document"
area: distributed-data
owner: Oleksandr Derechei
tags: [persistence, data-access, read-optimization]
status: stable
aliases: [posting list index, inverted file]
solves: [searching text with LIKE percent word percent scans the whole table and gets slower as rows grow, a keyword search over millions of documents takes seconds, I need to find every document that contains all of several words, filtering by many tags with AND and OR is slow on my table, a normal database index cannot find a word in the middle of a text column]
---

# Inverted Index

An index keyed by term rather than by document: each term points to a sorted list of the documents containing it, so a query touches only the lists of its words.

## What it is
<!--meta block=description-->

To find the documents containing a word, a plain table makes you read every row. At 10 million documents that is a full scan per query, and the cost grows with every document you add. An inverted index flips the lookup: it stores, for each term, a sorted list of the documents that contain it. A query reads only the lists for its words and merges them. Search engines, log search and database full-text indexes all rest on it.

## Explained
<!--meta block=explain-->

An inverted index answers "which documents contain this word" without reading the documents. At write time an analyzer splits each document into terms, and the index keeps, for each term, a sorted list of the ids of documents that contain it (a posting list). A query is analyzed the same way, then the lists of its terms are intersected for AND or merged for OR, and the matching ids are scored and returned. Choose it over a scan or an ordinary B-tree index (one that orders whole values) when users type free text, because a B-tree cannot find a word in the middle of a field. Writers add small immutable segments and merge them later, in the manner of an LSM tree, so search is fast and writes stay sequential.

- **Write cost.** One document updates a list per distinct term, so write in batches and accept a refresh delay before it is searchable.
- **Size.** Lists, positions and statistics can rival the text itself, so store ids as compressed gaps.
- **Lazy deletes.** A deleted document stays in its segment until a merge rewrites it, so keep spare disk for merges.
- **Analyzer lock-in.** A wrong tokenizer hides documents silently, and changing it means reindexing everything.

**Example.** You hold 10 million product descriptions of about 50 words each. A scan reads 500 million words per query, on the order of a second. The index holds about 2 million distinct terms: "waterproof" has a list of 80,000 ids and "jacket" has 120,000. A query for both reads those two lists, about 200,000 small integers, and intersects them in milliseconds, letting the shorter list drive the merge. The price is that adding one description touches about 40 lists, so you write in batches, and a new product shows up only after the next refresh, an interval you set, often about a second.

## How it works
<!--meta block=structure-->

```mermaid caption="How does a text query avoid scanning every document? Documents are split into terms at write time, each term owns a sorted list of document ids, and a query merges only the lists of its words."
flowchart LR
    Doc["New document"]
    Q["Query: two words"]
    subgraph IDX["Inverted index"]
        An["Analyzer: split, lowercase, stem"]
        Dict[("Term dictionary")]
        Post[("Posting lists: sorted document ids")]
    end
    Docs[("Document store")]
    Doc -->|"1 text"| An
    An -->|"2 terms"| Dict
    Dict -->|"3 term points to its list"| Post
    Q -->|"4 same analyzer on the query"| Dict
    Post -->|"5 intersect or union lists"| Post
    Post -->|"6 ranked ids"| Docs
```

```mermaid caption="Write and read paths. Writes are buffered into an immutable segment; reads merge lists across segments."
sequenceDiagram
    participant W as Writer
    participant B as In-memory buffer
    participant S as Segments on disk
    participant R as Reader
    W->>B: add document, update term lists
    B->>S: flush as a new immutable segment
    S->>S: merge small segments in the background
    R->>S: look up each query term in every segment
    S-->>R: merged posting lists, then scores
```

## Variations
<!--meta block=variations-->

- **Positional postings** — Each entry also stores the word's position in the document, so phrase queries ("red wine") and proximity queries can check that the words sit next to each other. It costs extra space per entry.
- **Boolean versus ranked retrieval** — Boolean retrieval returns every document matching an AND, OR or NOT expression. Ranked retrieval scores the matches by term frequency and rarity, and returns the top few.
- **Segmented and merged** — Writers never edit a list in place. They add a small immutable segment and merge segments later, the same idea as an [LSM tree](lsm-tree.md), which keeps writes sequential.
- **Sharded by document or by term** — Splitting by document gives each shard a full index of its slice, so a query fans out to all shards. Splitting by term sends a query to few shards, but one hot word overloads its shard.
- **Skip lists and compression** — Lists store id gaps in compressed blocks with skip pointers, so an intersection jumps past ids it cannot match instead of reading them all.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Query cost follows the list sizes** — a query reads only its terms' lists, not the corpus, so latency grows with the length of those lists, and rare terms stay fast as documents are added.
- **Boolean logic is cheap** — AND is an intersection of sorted lists, OR is a union and NOT a difference, all single passes.
- **Ranking inputs sit in the entries** — term counts and positions stored beside each id let you score without reopening documents.
- **Lists compress well** — sorted ids stored as small gaps take far fewer bytes than raw ids, though positions and statistics can still add up to the text's size.

### Cons
<!--meta polarity=con-->

- **Writes touch many lists** — one document updates a list per distinct term, so batch into segments and accept a short delay before new documents show.
- **Deletes and updates are lazy** — a deleted document is only marked, and its entries linger until a merge rewrites the segment. Budget disk for that.
- **A common word makes a huge list** — a query on a very frequent term reads millions of ids. Drop stop words (very common words such as "the"), cap candidates, or let a rarer term drive the merge.
- **It answers only what you analyzed** — a wrong stemmer (which cuts words to a root, so "running" matches "run") or tokenizer hides documents silently, and changing the analyzer means reindexing everything.
- **It is a second copy of your data** — it lags the source of truth, so feed it by [change data capture](change-data-capture.md) and be ready to rebuild it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Users search free text** across many documents and expect results in tens of milliseconds.
- **A LIKE '%word%' scan** has become your slowest query and a normal index cannot serve it.
- **You filter by many tags or terms** and combine them with AND and OR.
- **You need ranked results**, not just a yes or no per document.

### Avoid when
<!--meta polarity=avoid-->

- **Lookups are by exact key or by a range of values**; an ordinary B-tree index is smaller and cheaper.
- **The corpus is small**, a few thousand rows, where a scan finishes in milliseconds.
- **You need new writes visible at once** with strict consistency; the refresh delay usually breaks that. Measure the time from write to first visible hit and compare it with your freshness budget.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a tiny in-memory inverted index: add documents, then AND-query by intersecting sorted lists"
const postings = new Map<string, number[]>();                // term -> sorted doc ids
const analyze = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]; // split, lowercase, dedupe

function add(docId: number, text: string) {                 // ids arrive in increasing order
  for (const term of analyze(text)) {
    const list = postings.get(term) ?? [];
    list.push(docId);                                        // appending keeps the list sorted
    postings.set(term, list);
  }
}

function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;                                                // advance the list that is behind
  }
  return out;
}

function search(query: string): number[] {
  const lists = analyze(query).map(t => postings.get(t) ?? []);
  lists.sort((x, y) => x.length - y.length);                 // start with the rarest term
  if (lists.length === 0) return [];  // empty query: reduce has no seed
  return lists.reduce(intersect);
}

add(1, "Waterproof rain jacket"); add(2, "Wool jacket"); add(3, "Waterproof boots");
search("waterproof jacket");                                 // [1]
```

## In the wild
<!--meta block=wild-->

- **Apache Lucene** — The Java search library whose index is segment-based: documents are written to immutable segments of term-to-document lists, and background merges combine them. Solr and Elasticsearch are built on it. {#wild-wild-lucene}
- **Elasticsearch** — A distributed search server built on Lucene. Each shard is a Lucene index, so by default a query fans out to every shard of an index and the results are merged. {#wild-wild-elasticsearch}
- **PostgreSQL GIN index** — Generalized Inverted Index, used for full-text search on tsvector columns, for arrays and for jsonb. It maps each element or lexeme to the rows that contain it. {#wild-wild-postgres-gin}

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Scaling Reads](../../../themes/scaling-reads.md) — Answer keyword searches from a prebuilt term-to-document index instead of scanning. {#fluency-scaling-reads}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [LSM Tree](./lsm-tree.md) — Writes go to small immutable segments that merge in the background, the same way a log-structured merge tree (LSM tree) works
- [Change Data Capture](./change-data-capture.md) — Feed the index from the source database's change log (change data capture) and rebuild from it if the index is lost
- [Trie](./trie.md) — A trie finds terms by prefix, the inverted index finds documents by whole term; together they give typeahead then search

**Demonstrated by**

- [Facebook Post Search](../../../designs/fb-post-search.md) — Shows the index at work, with in-memory lists for a write-heavy firehose of posts and likes

**Implemented by**

- [Search engines](../../../comparisons/search-engines.md) — Runnable products that provide this index
- [Data & Analytics](../../../capabilities/data-analytics.md) — Managed search is an inverted index you rent rather than build.

<!-- relationships:end -->
