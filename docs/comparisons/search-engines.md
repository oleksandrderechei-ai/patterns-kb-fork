---
title: Search engines
description: "Seven ways to answer a text query: a Lucene cluster, a single typo-tolerant binary, or the index already inside your database"
area: comparisons
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization, data-access, cloud]
status: stable
aliases: [elasticsearch, opensearch, solr, meilisearch, typesense, lucene]
solves: [I cannot tell which self-hosted search engine to pick when several are near copies, LIKE queries on the database are too slow and the matches come back in no useful order, users mistype the product name and get zero results, our search engine changed its license and we do not know what to replace it with, we are running a three-node cluster to power one search box]
---

# Search engines

Seven engines that answer the same question — which documents match this text, and in what order — separated by how much relevance tuning they hand you, how much cluster they make you run, and which license they ship under.

## What this compares
<!--meta block=description-->

A search engine is a second copy of your data, shaped for one question: which documents match this text, and in what order. Reach for one when a LIKE scan in your [database](../capabilities/databases.md) slows with every row. The seven contenders differ in how much relevance tuning they expose, the cluster you operate, and license. The index is a projection you keep in sync yourself, and a write that never reaches it leaves search returning stale answers with no error.
## Explained
<!--meta block=explain-->

Try your database's own full-text search first and keep it until relevance demands more, since it adds no system to run and no copy to keep in step. A LIKE scan slows with every row and returns matches in no useful order. Move on when someone asks for typo tolerance, per-field boosts or facet counts. Choose OpenSearch or Elasticsearch for Lucene-grade control and wider analytics, and a single-binary engine such as Meilisearch or Typesense for product search-as-you-type over a catalogue you can size. Both big engines are open source again, so choose between them on ecosystem and governance.

- **The index is a copy another store owns.** A write that never reaches it leaves stale answers, so compare it against the source periodically.
- **A cluster has heap, shards and node roles to run.** Buy it managed unless you have the team.
- **An in-memory engine is capped by RAM.** Measure your corpus first.
- **Writes show after a refresh.** One second by default in Elasticsearch and OpenSearch; an analyzer change forces a reindex from the source.

**Example.** A shop has 100,000 products and 2,000 price changes a day. A sync bug loses 0.5 percent of them, which is 10 a day. After 30 days, 300 products show a wrong price in search, and nothing flags it. A nightly job compares each product's price and update time in the index against the database and re-indexes the mismatches, which holds the stale count to at most 10. The cost is a job that reads all 100,000 rows each night, plus an alert that fires when the mismatch count rises.

## The contenders
<!--meta block=contenders-->

- **Elasticsearch** — Lucene behind a JSON query language, with the largest ecosystem of these engines: Kibana, ingest pipelines, application performance monitoring (APM). Triple-licensed AGPLv3, ELv2 or SSPLv1 since August 2024. Elastic Cloud is the vendor's managed service.
- **OpenSearch** — The Apache-2.0 fork of Elasticsearch 7.10.2, still Lucene-based and shaped like its ancestor. Governed since September 2024 by the OpenSearch Software Foundation under the Linux Foundation; Amazon OpenSearch Service is the managed offering.
- **Meilisearch** — A single binary aimed at instant search-as-you-type, with typo tolerance on by default and a short list of ranking rules you reorder. MIT-licensed. Meilisearch Cloud runs it for you.
- **Typesense** — A single binary that holds its index in memory and is typo-tolerant by default: steady latency while the index fits in RAM, and RAM is the limit on how much you can index. GPL-3. Typesense Cloud runs it for you.
- **PostgreSQL full-text search** — The do-less option: a `tsvector` column and an index inside the database you already operate, under the permissive PostgreSQL license. No second system, no sync to get wrong, and relevance tuning limited to field weights, ts_rank and dictionaries.
- **Apache Solr** — The older Lucene server, Apache-2.0, with mature faceting and SolrCloud coordinating a cluster through ZooKeeper. No vendor cloud defines it, so you operate it or buy hosting from a partner. It has no column in the matrix.
- **Azure AI Search** — Azure ships no first-party Lucene-family engine; Azure AI Search is its own proprietary service, sold managed. Choose it when staying inside Azure's identity and billing outweighs portability, and assume nothing about its internals. It has no column in the matrix.

## How they compare
<!--meta block=matrix-->

| Criterion | Elasticsearch | OpenSearch | Meilisearch | Typesense | Postgres FTS |
| --- | --- | --- | --- | --- | --- |
| Relevance tooling | Full Lucene analyzer chain and custom scoring | The same toolkit, inherited from the fork | A short list of ranking rules you reorder | Field weights and a fixed ranking order | Text matching with `ts_rank`, and little else |
| Typo tolerance | Opt in per query with a fuzziness setting | Opt in per query with a fuzziness setting | On by default | On by default | Add the trigram extension yourself |
| Scale shape | Cluster of shards and replicas | Cluster of shards and replicas | One process, optionally replicated | One process, optionally a small high availability (HA) cluster | Whatever your database already is |
| License | AGPLv3, ELv2 or SSPLv1 | Apache-2.0 | MIT | GPL-3 | PostgreSQL license |
| Managed offering | Elastic Cloud | Amazon OpenSearch Service | Meilisearch Cloud | Typesense Cloud | Any managed Postgres you already pay for |
| Ops burden | Java virtual machine (JVM) cluster: heap, shards, node roles | JVM cluster: heap, shards, node roles | One binary to run and back up | One binary, sized against RAM | Index maintenance, nothing new to operate |
| Aggregations and analytics | Aggregations over the matched set; doubles as a log store | The same aggregations | Facet counts, not an analytics engine | Facet counts, not an analytics engine | Plain SQL, including `GROUP BY` |
| Vector and hybrid search | Vector fields with hybrid ranking | Vector fields with hybrid ranking | Ships vector search | Ships vector search | Via the `pgvector` extension |
| Where the index lives | On disk, memory-mapped; page cache sets latency | On disk, memory-mapped; page cache sets latency | On disk, memory-mapped | In memory; RAM caps the corpus | In your table's storage, as a GIN index |
| Who steers it | Elastic, the vendor | OpenSearch Software Foundation (Linux Foundation) | The company behind it | The company behind it | PostgreSQL Global Development Group |

## Choosing between them
<!--meta block=choosing-->

Try Postgres full-text search first and keep it until someone asks for typo tolerance, per-field boosts or facets and the answer takes a week. Postgres runs on the same server as your transactional load and shares its CPU and I/O, so watch both.

Take OpenSearch when you want Lucene's power under a permissive license, or when you are already on AWS and the managed service is a checkbox. Take Elasticsearch when the ecosystem around it (Kibana, ingest pipelines, application performance monitoring) is what you are buying, and its license terms are ones your legal team will sign.

Take Meilisearch or Typesense when the job is product search-as-you-type over a catalogue you can size, and a single binary beats standing up a cluster. Typesense trades a RAM ceiling for steadier latency, so measure the corpus before you pick it.

Take Solr when you already run it. It is mature, permissively licensed and good at faceting, and none of that is a reason to introduce ZooKeeper to a stack that has no other use for it.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Databases](../capabilities/databases.md) — Search is a read-optimized index beside your database, not a replacement for it

**Implements**

- [Inverted Index](../patterns/distributed/coordination/inverted-index.md) — Lucene-based engines and the index inside a database such as PostgreSQL (GIN, the Generalized Inverted Index) are ready-made inverted indexes
- [Embeddings](../patterns/ml/embeddings.md) — Which engines store and search embedding vectors beside text.

<!-- relationships:end -->
