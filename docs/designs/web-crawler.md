---
title: Web Crawler
description: Fetch and extract text from 10 billion web pages in under five days — without losing progress or overloading any site
area: designs-foundational
owner: Oleksandr Derechei
tags: [scalability, throughput, error-handling]
status: stable
aliases: [spider, web spider]
solves: ["I need to download and extract text from billions of web pages and finish within days, not months", "one worker does the whole fetch-and-parse job, so when it dies mid-page I lose all of its progress", my fetchers keep hammering the same site and getting throttled or blocked, different links keep handing me the exact same page and I waste time re-processing duplicates, a page full of self-referential links keeps my fetchers looping forever on one site]
---

# Web Crawler

A web crawler starts from a handful of seed URLs, downloads each page, keeps the text worth keeping, harvests the links it finds, and follows them outward across the web — here, to gather raw training text for a language model. At ten billion pages the design is dominated by three forces pulling against each other: finish fast, never lose work when a fetch fails, and stay a polite guest on every site it touches.

## Understanding the problem
<!--meta block=description-->

A crawler fetches a page, extracts its text, finds the outbound links and repeats, here to harvest text at scale for training a language model. With roughly 10 billion reachable pages, one machine cannot cover them in a sensible window. The design balances speed and cost, clean resumption after a failed fetch, and politeness toward each site. The page walks through the fetch and parse pipeline that meets those goals.

## Explained
<!--meta block=explain-->

A web crawler splits the work into two stages joined by [queues](../patterns/messaging/message-queue.md): fetchers download a page and store its HTML in blob storage, and parsers read the HTML back, keep the text and send the links they find to the list of URLs still to visit. A failure then loses one URL, not a whole unit of work, and queue messages carry only an id, never the HTML. Choose separate stages over one process that does everything, because the fetch is the flakiest step and a failed message simply reappears for another worker. Do the arithmetic first: 10 billion pages in 5 days is about 23,000 pages a second, and you should load-test the machine count because it rests on an assumed utilisation. Limit each domain to about 1 request a second with an atomic claim, and add random jitter so waiting fetchers do not all retry when a window resets.

- **Name lookups.** Across millions of domains, domain-name lookups, not bandwidth, become the bottleneck. Cache lookups in each fetcher and use several resolvers.
- **Crawler traps.** Endless link chains never finish. Cap depth and normalise URLs; a content hash skips only exact duplicates, not pages that differ per visit.
- **Skipped pages.** A probabilistic seen-set ([Bloom filter](../patterns/distributed/coordination/bloom-filter.md)) saves memory but occasionally skips a page you never fetched. Size it for a low error rate.

**Example.** The crawl needs 10 billion pages in 5 days, 432,000 seconds, about 23,000 pages a second. A 200 Gbps machine could pull 200 / 8 / 2 MB = 12,500 pages a second; at 30% real utilisation that is 3,750. One machine needs 10 billion / 3,750, about 31 days; 8 machines need about 3.9 days. A fetcher that dies mid-download never deletes its message, so it reappears for another worker. After 5 failed receives it moves to a dead-letter queue and the site is marked offline.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Start from a given set of seed URLs and crawl outward by following the links on each page.
2. Extract the text from every page and store it for later processing.

Out of scope: actually training the model on the text, non-text media (images, video), JavaScript-rendered content, and login-gated pages — named so the design stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Fault tolerance** — a failure anywhere resumes without discarding crawled progress.
- **Politeness** — honour `robots.txt` and never overload a site's servers.
- **Efficiency** — the whole crawl completes in under 5 days.
- **Scalability** — handle roughly 10B pages, aiming at the vast majority of the web, since complete coverage is a fiction.

Out of scope: defending against malicious actors, cost/budget limits, and legal or privacy compliance.

## Right-sizing
<!--meta block=sizing-->

**The work.** ~10B pages, and for bandwidth planning budget a pessimistic **2&nbsp;MB** of transfer per page (worst case with inline resources — the raw HTML alone is closer to 30&nbsp;KB). The text must be ready **5 days** after the crawl starts.

**Required rate.** 10B pages over 5 days (≈432,000&nbsp;s) is about **23,000 pages/sec**, sustained every second for five days straight. That number sets the whole scaling problem.

**What one machine does.** A network-optimised instance (~200&nbsp;Gbps — AWS `c6in.32xlarge` or `c7gn.16xlarge`) can in theory pull 200&nbsp;Gbps ÷ 8 bits ÷ 2&nbsp;MB ≈ **12,500 pages/sec**. Real utilisation is far lower — call it 30% once DNS, server latency, politeness waits and retries are paid — so ≈ **3,750 pages/sec** per machine.

**Machine count.** One machine needs 10B ÷ 3,750 ≈ 2.7M&nbsp;s ≈ **31 days**; run **eight** in parallel and it drops to ≈ 3.9 days, comfortably inside the window. The math is assumption-laden — its value is the reasoning, and a real deployment would load-test. Politeness caps coverage: at 1 request a second a single domain yields at most about 432,000 pages in 5 days (432,000 s x 1), so the plan needs at least 23,000 domains in flight at once and very large sites will not be crawled in full.

**Storage.** Raw HTML at ~30&nbsp;KB × 10B ≈ **300&nbsp;TB**; the extracted text is a fraction of that. Both land in blob storage — never in the queue or the database.

## Core entities
<!--meta block=entities-->

A handful of pieces of state, split by what they hold:

- **Frontier queue** — the set of URLs still to crawl; primed with the seeds and constantly growing as new links are discovered.
- **URL record** (Metadata DB) — one row per URL: the URL itself, its status, a reference to its raw-HTML blob and its extracted-text blob, a content hash, and a crawl `depth`.
- **Domain record** (Metadata DB) — per domain: the parsed `robots.txt` rules (disallowed paths, crawl-delay) and the timestamp of the last crawl.
- **Blob storage** — the actual bytes: raw HTML written by the fetch stage, extracted text written by the parse stage.
- **Extraction queue** — carries fetched pages from the fetch stage to the parser workers, one message per URL.

## The interface
<!--meta block=interface-->

This is not a user-facing system, so the "interface" is the system boundary itself — seed URLs in, text blobs out — plus the loop that runs between them. Sketching that loop first makes the components fall out naturally:

```python summary="Pseudocode — the system boundary and the crawl loop"
# boundary
input:  seedUrls: [URL]          # prime the frontier
output: text blobs in object storage, indexed by the Metadata DB

# fetch stage — one URL pulled from the frontier
def fetch(url):
    rules = robots.rules(domain(url))     # fetched once per domain, kept on the Domain row
    if disallowed(url, rules): return ack(url)
    if not redis.set(domain(url), 1, nx=True, ttl=rules.crawl_delay): return defer(url)  # lost the claim: ChangeMessageVisibility
    ip   = dns.resolve(host(url))
    html = http_get(url, ip)
    ref  = blob.put(html)                 # raw HTML to blob storage
    id   = db.record(url, html_ref=ref)   # a row in the Metadata DB
    extraction_queue.send(id)             # just the id — never the HTML

# parse stage — parser workers
def extract(id):
    html        = blob.get(db.html_ref(id))
    if db.seen_hash(hash(html)): return   # content dedup before the parse
    text, links = parse(html)
    blob.put(text)
    for l in links:                       # after URL + content dedup
        frontier.enqueue(l, depth=depth(id) + 1)   # dropped past the depth cap
```

## How the system is built
<!--meta block=architecture-->

The naïve shape — one crawler that resolves DNS, fetches, extracts text and extracts links in a single process — is where the design begins and immediately gets refactored, because a failure in any step throws away the whole unit of work. The built system pulls those responsibilities apart into two queue-separated stages. A pool of interchangeable **URL Fetchers** pull URLs off the frontier, download the HTML and drop it in blob storage; a pool of **Parser Workers** read that HTML back, extract the text, and feed newly discovered links to the frontier. Because every worker in a pool is stateless and pulls from a shared queue, they are [competing consumers](../patterns/messaging/competing-consumers.md) — add machines to add throughput, and a dead worker just leaves its message for the next one. The frontier and the extraction hand-off are managed queues (SQS (Simple Queue Service) is the choice, argued below); the raw HTML and extracted text live in [object storage](../patterns/distributed/routing/object-storage.md) (Simple Storage Service, S3) for its durability and cost at this volume; a Metadata DB (DynamoDB, or Postgres/MySQL) tracks every URL and domain.

```mermaid caption="Two pipelined stages pass work through queues; raw HTML and extracted text land in blob storage, the queue messages carry only ids, and discovered links loop back into the frontier."
flowchart TB
    Seeds["Seed URLs"] -->|"seed"| Frontier[("Frontier queue")]
    Frontier -->|"next URL"| Fetcher["URL Fetchers"]
    Fetcher -->|"GET page"| Web["External sites"]:::ext
    Fetcher -->|"raw HTML"| Blob[("Blob storage")]
    Fetcher -->|"record URL + domain"| Meta[("Metadata DB")]
    Fetcher -->|"HTML row id"| Extract[("Extraction queue")]
    Extract -->|"id"| Parser["Parser Workers"]
    Parser -->|"read HTML / write text"| Blob
    Parser -->|"new links"| Frontier
    Parser -->|"hash, depth"| Meta
    classDef ext stroke-dasharray:4 4;
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Staying fault-tolerant without losing progress

The single-process crawler is fragile: DNS lookup, fetch, text extraction and link extraction all share one fate, and the fetch — dead servers, slow connections, oversized responses — is by far the flakiest step. Split the work into a [pipe-and-filter](../patterns/architecture/pipe-filter.md) pipeline of independently retryable stages: the fetcher only downloads and stores HTML; the parser only reads HTML and pulls out text and links (kept as one stage because both are cheap and CPU-bound). Now a failure is isolated to a single URL, each stage scales on its own, and the text-extraction logic can change — say, to also grab image alt-text — without redoing the expensive fetch. The state that ties the stages together is the Metadata DB row, which points at the HTML and text blobs.

One anti-pattern to call out: never put the multi-megabyte HTML in the queue message. Queues are built for small payloads, and stuffing bytes through them is slow and costly. The message carries only the row's id; the payload sits in blob storage and the worker fetches it by reference — the [claim-check](../patterns/messaging/claim-check.md) pattern.

Fetches will fail, so retry with backoff. An in-memory timer is the naïve answer and loses its state the moment the worker dies. Kafka has no native retry — you would hand-roll a failed-URLs topic carrying a next-retry time. SQS gives it almost for free: its visibility timeout (default 30&nbsp;s, extendable to 12&nbsp;h) hides an un-acked message and makes it reappear when the timer expires, and calling `ChangeMessageVisibility` keyed on the message's `ApproximateReceiveCount` turns that into [exponential backoff](../patterns/distributed/resilience/retry-backoff.md). Cap the failures with a redrive policy: after `maxReceiveCount` receives (say 5) the message moves to a [dead-letter queue](../patterns/messaging/dead-letter-channel.md) and the site is treated as offline. Crash recovery falls out of the same mechanism — a message is deleted only after its HTML is safely in blob storage, so a fetcher that dies mid-download simply lets the message resurface for another worker.

### 2 · Being a polite guest

Two obligations. First, `robots.txt`: fetch it once per domain, parse its `Disallow` paths and any `Crawl-delay`, and store the rules plus a last-crawl timestamp on the Domain row. On dequeue, if the URL is disallowed, acknowledge it and move on; if the crawl-delay hasn't elapsed, don't crawl — defer the message with `ChangeMessageVisibility` (SQS's `DelaySeconds` only applies to newly-sent messages, so for an in-flight one the visibility timeout is the deferral knob). `Crawl-delay` isn't part of the official protocol and some big crawlers ignore it, but respecting it is good etiquette. A deferral is another receive, so it raises `ApproximateReceiveCount`: set `maxReceiveCount` above the deferrals a busy domain should see, or count only failed fetches toward the cap, or a polite URL reaches the dead-letter queue and the site is marked offline.

Second, cap the request rate per domain — the industry rule of thumb is ~1 request/second/domain, aggregated across every fetcher. A central store (Redis) tracks per-domain request counts in a sliding window, and each fetcher checks before it hits the origin: a distributed [rate limiter](../patterns/distributed/resilience/rate-limiter.md). This doesn't throttle aggregate throughput because the crawl spans millions of domains at once — the limit is per-domain, and there are millions of domains in flight.

The subtle bug is a race: several fetchers can read the same stale last-crawl time simultaneously and all conclude it's their turn — a classic check-then-act. Fix it with an atomic per-domain claim before crawling: `Redis SET domain NX` with a TTL (time to live) equal to the crawl delay, a lightweight [distributed lock](../patterns/distributed/coordination/distributed-lock.md). Whoever wins the key crawls; the losers defer their message. And when a rate-limit window resets, every waiting fetcher can retry in lockstep — a [thundering herd](../hazards/thundering-herd.md) — so add per-fetcher jitter to spread the retries out. The atomic claim alone holds a domain to one fetch per crawl delay; the sliding-window counter is the alternative way to enforce the limit, not an addition, and matters for rates above 1 request a second.

The per-domain claim is what closes the check-then-act race:

```mermaid caption="How does an atomic per-domain claim stop two fetchers hitting the same domain inside its crawl delay?"
sequenceDiagram
    autonumber
    participant A as Fetcher A
    participant B as Fetcher B
    participant R as Redis
    participant O as Origin site
    A->>R: SET domain NX, TTL = crawl delay
    R-->>A: key set, A wins
    B->>R: SET domain NX, TTL = crawl delay
    R--xB: key exists, B loses
    B->>B: defer message (ChangeMessageVisibility), add jitter
    A->>O: GET page
```

### 3 · Hitting 10 billion pages in five days

The throughput math (above) says eight ~200&nbsp;Gbps machines at 30% real utilisation clear 10B pages in ≈3.9 days. Parser workers scale more simply — they only read HTML and write text — so autoscale them on the extraction queue's depth rather than provisioning a fixed count (Lambda or Fargate). The real surprise is DNS: at thousands of requests per second across millions of unique domains, resolution becomes the bottleneck. The classic Mercator crawler paper found DNS could eat up to 70% of a thread's time before they built a custom resolver. Mitigate with a DNS cache in each fetcher (repeat lookups for a domain are free) and round-robin across multiple DNS providers to spread load and dodge per-resolver limits.

Efficiency also means not crawling the same thing twice. Two layers of deduplication: **URL-level** — check the Metadata DB before enqueueing and skip URLs already seen; and **content-level** — different URLs can serve identical bytes (`example.com` vs `www.example.com`, mirrors, syndicated pages), so hash the fetched content and check membership before the expensive parse. Either index the hash column in the Metadata DB (simple, and modern indexes handle the scale fine) or keep a [Bloom filter](../patterns/distributed/coordination/bloom-filter.md) of seen hashes — a probabilistic set that says "definitely never seen" or "probably seen," trading a small false-positive rate (occasionally skipping a page you didn't actually crawl) for tiny memory. RedisBloom's `BF.ADD`/`BF.EXISTS` is the ready-made tool, though for this case the indexed column is arguably enough.

Finally, crawler traps — self-linking loops and link farms — can hold a fetcher on one site forever. Cap the crawl depth (link hops from a seed, not URL path segments) by carrying a `depth` field per URL and abandoning a branch once it passes a threshold (~15–20). Beyond the core, a few natural extensions: a `HEAD` request to read `Content-Length` and skip oversized files before downloading them; a headless browser (Puppeteer) for JavaScript-rendered pages; and, if the one-time crawl becomes a recurring one, a URL Scheduler that decides what to re-crawl from last-crawl-time and popularity instead of parsers writing links straight to the frontier.

```mermaid caption="How does one URL survive fetch failures and worker crashes without losing progress or retrying forever?"
stateDiagram-v2
    [*] --> Queued: URL on the frontier
    Queued --> Fetching: fetcher dequeues, visibility timeout hides message
    Fetching --> Stored: HTML in blob storage, message deleted
    Fetching --> Backoff: fetch fails or worker dies
    Backoff --> Fetching: visibility timeout expires, message resurfaces
    Backoff --> DeadLetter: maxReceiveCount exceeded, site treated as offline
    Stored --> [*]
    DeadLetter --> [*]
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Pipelined stages isolate the fragile fetch — a crash retries one URL, not the whole unit of work, and each stage scales independently.
- Politeness and rate limits are enforced centrally, so the crawl fans across millions of domains and a well-behaved fetcher is unlikely to be blocked by any single site.
- A managed queue supplies backoff (visibility timeout) and a failure cap (dead-letter queue) almost for free, and URL + content dedup keeps the 5-day budget realistic.

### What it gives up
<!--meta polarity=con-->

- The throughput plan rests on assumption-laden estimates (30% utilisation, 2&nbsp;MB/page); the real numbers need load testing.
- Bloom-filter dedup risks false positives, so a page never actually crawled can be silently skipped; an indexed content-hash column is exact but costs a lookup per page.
- Blunt heuristics leak: treating `robots.txt` as a one-time download leaves rules stale, and offline-after-5-retries plus a fixed max depth can drop legitimately reachable pages.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — lays out the high-level data flow (seed → frontier → fetch → extract → store → enqueue links) and a simple working crawl, can explain what a queue does, and covers the basics of politeness and `robots.txt`; not expected to go deep on queue technology or rate limiting.
- **Senior** — drives the fault-tolerance framing, splits the monolith into pipelined stages unprompted, goes deep on politeness (robots.txt, per-domain rate limiting, and the check-then-act race with its lock), and shows the crawl fits the five-day window with real throughput math.
- **Staff+** — reaches for concrete technology from experience (SQS visibility timeout and DLQ, `Redis SET NX`, RedisBloom), anticipates bottlenecks like DNS resolution and crawler traps and pre-empts them (DNS caching, multi-provider round-robin, max depth), and treats dedup, monitoring, and a continual re-crawl scheduler as operational realities.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Thundering Herd](../hazards/thundering-herd.md) — When a per-domain rate-limit window resets, every waiting fetcher can retry in lockstep, so per-fetcher jitter spreads the retries.

**Demonstrates**

- [Pipe-and-Filter](../patterns/architecture/pipe-filter.md) — splits the fragile single-process crawler into independently retryable fetch and parse stages
- [Claim Check](../patterns/messaging/claim-check.md) — the queue message carries only the Metadata database (DB) row id while the multi-megabyte HyperText Markup Language (HTML) sits in blob storage
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — pools of interchangeable fetchers and parser workers pull from shared queues, adding machines to add throughput
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — failed fetches back off via the Simple Queue Service (SQS) visibility timeout extended by ApproximateReceiveCount
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — a redrive policy moves a URL to a dead-letter queue (DLQ) after maxReceiveCount receives, marking the site offline
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — a central Redis sliding window caps requests to ~1/sec/domain across all fetchers
- [Distributed Lock](../patterns/distributed/coordination/distributed-lock.md) — Redis SET NX with a crawl-delay time to live (TTL) gives one fetcher an atomic per-domain claim, closing the stale-timestamp race
- [Bloom Filter](../patterns/distributed/coordination/bloom-filter.md) — content hashes of crawled pages are checked in a probabilistic set to skip re-parsing duplicates cheaply
- [Object Storage](../patterns/distributed/routing/object-storage.md) — raw HyperText Markup Language (HTML) and extracted text live in S3 for durability and low cost at hundreds of terabytes
- [Message Queue](../patterns/messaging/message-queue.md) — the frontier and the extraction hand-off are durable managed queues, so a worker that dies mid-URL loses one message rather than its stage's work
- [Sliding Window](../patterns/distributed/coordination/sliding-window.md) — a central Redis sliding window caps requests per domain across the whole fetcher fleet

<!-- relationships:end -->
