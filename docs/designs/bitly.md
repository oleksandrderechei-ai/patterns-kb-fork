---
title: Bitly
description: Generate short codes from a counter and serve every redirect from memory and the edge
area: designs-foundational
owner: Oleksandr Derechei
tags: [caching, read-optimization, latency]
status: stable
aliases: [URL shortener, TinyURL, short links]
solves: [I need to turn long links into short ones and redirect them in milliseconds, my reads outnumber writes a thousand to one and one database cannot keep up, how do I generate short unique ids without two requests colliding on the same code, predictable sequential ids let anyone enumerate every record in my system, one viral link is hammering a single hot key and melting the database under it]
favourite: true
---

# Bitly

A URL shortener maps a long link to a short code and sends everyone who follows that code back to the original. Creating a link is a single row write; following one is the entire system — so every decision on this page is a decision about the read path.

## Understanding the problem
<!--meta block=description-->

A URL shortener accepts a long URL and returns a short one that redirects to the original. The product is two endpoints wide, but one link is written once and then followed by strangers for years, with no warning of which goes viral. This page walks through collision-free codes, redirects served without a disk read, codes that cannot be guessed, and surviving one link everybody clicks at once.

## Explained
<!--meta block=explain-->

A link shortener turns a counter value into a short code, stores the code and its long address once, and then answers every click from memory or from a cache near the reader. Links are written rarely and read constantly, roughly a thousand reads for each write, so spend your effort on reads. Choose one database with a cache in front over splitting the data across many servers when the data is small: 1 billion links at about 500 bytes each is 500 GB, and writes run at about 6 a second, so the read rate forces the cache, not the size.

- **Walkable codes.** Counter values can be guessed in order, so scramble each with a keyed one-to-one transform and use 7 characters.
- **Viral stampede.** One expired cache entry for a viral code sends every reader to the database, so serve stale while one request refreshes it.
- **One write path.** No new links while it fails over, so keep a warm standby; cached codes keep redirecting, a cold-code miss waits for promotion.

**Example.** A link in a television ad draws 600,000 redirects a second, against a sustained 17,000 for the whole service. The redirect carries max-age=300, so each edge location asks the origin for that code at most once every 300 s, and 600,000 clicks a second land on the edge, not on your servers. The cost is that if you delete the link, it can keep redirecting for up to 300 s. A guesser does worse: with 6 characters, 1 billion live codes fill 1.8% of the space, so 1 guess in 57 hits a link; with 7 characters it is 1 in 3,500.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Submit a long URL and receive a short URL in return.
2. Optionally choose a custom alias, and optionally set an expiration date.
3. Visit a short URL and be redirected to the original.

Out of scope: accounts and click analytics — named explicitly so the design stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Uniqueness** — every short code maps to exactly one long URL.
- **Latency** — redirects under 100&nbsp;ms when the edge or cache holds the code; a cold first click from another continent also pays the ~160&nbsp;ms round trip (dive 2).
- **Availability** — 99.99%, favoured over strict consistency (a stale mapping is harmless; a dropped redirect is not).
- **Unguessability** — holding one code must not hand you the next, and the space must be sparse enough that guessing is not worth the bandwidth.
- **Scale** — 1B stored URLs, 100M daily actives, with reads dwarfing writes by roughly 1000:1.
- **Hot links** — one link in a television advert can draw hundreds of thousands of requests per second (about 600k/s in the sizing burst); it must not saturate a single row.

## Right-sizing
<!--meta block=sizing-->

Three things fall out of the arithmetic. The data is small enough to keep on one machine, the writing is so rare it barely registers, and the reading is enormous and lumpy — a handful of links carry most of it. Everything this design spends money on is there to make reading cheap and close to the reader.

**The problem:** a billion stored links and 100M daily actives, where the load that decides the architecture is people following links, not people making them. **The shape:** synchronous request/response — a redirect is one lookup answered in one hop, nothing waits on a human, a vendor or a batch window, and no state change has to be told to another system, so none of the reasons to go event-driven apply. **The stores:** three that we run — the durable link store, a shared read cache, and the id allocator's counter — plus a rented edge cache, which is capacity bought rather than operated.

**Required capabilities:**

- Durable key-value store with a uniqueness constraint — 1B `code → URL` rows, read only by exact key, and the last word on a duplicate code. → non-functional requirement (NFR): uniqueness; functional requirement (FR): redirect.
- Read cache in its own tier — the hot mappings held in memory in front of a store that cannot answer the peak from disk. → NFR: latency.
- Edge cache near the reader — the latency budget is spent on geography before it is spent on work. → NFR: latency.
- Monotonic id allocator — many stateless writers, one sequence, no read-before-write. → NFR: uniqueness.
- Keyed permutation over the id space — a one-to-one transform that hides adjacency, so consecutive ids do not become neighbouring codes. → NFR: unguessability.
- Warm standby of the link store — 99.99% needs a copy to promote, which is a different job from a copy to read. → NFR: availability.
- Rate limiting keyed on source and miss rate — a sparse code space stays unwalkable only while nobody can probe it millions of times. → NFR: unguessability.

**The numbers:**

- Reads: 100M DAU (daily active users) × ~5 followed links/day (assumed: an active user opens a handful of shared links) ≈ 500M/day ≈ **5.8k redirects/s mean at the edge**. → NFR: scale.
- Sustained peak: ×3 for time-zone concentration (most of the day's traffic lands in its busiest third) ≈ **17k redirects/s** — the rate the origin must survive with a cold cache. → NFR: scale.
- Burst peak: campaign and viral traffic concentrates on a few codes; budget ~100× the mean for minutes at a time ≈ **600k redirects/s**, nearly all of it on a handful of keys — an edge problem, not a store problem. → NFR: latency.
- Writes: the 1000:1 ratio stated as a rate — ~500k new links/day ≈ **5.8 row-writes/s**, perhaps 50/s while a customer bulk-loads a campaign, and ~5.5 years of that to accumulate the billion rows above. A single primary is untroubled below ~100 writes/s. → NFR: scale.
- Allocator traffic: 500k links/day ÷ 1000-value blocks ≈ **500 allocator calls/day** — the design's only coordination point is touched about twenty times an hour. → NFR: uniqueness.
- Storage: 1B rows × ~500 B (7-byte code, a ~200-byte URL on average with a long tail, timestamps, flags) ≈ **500&nbsp;GB**, plus a primary-key index at ~40 B/entry ≈ **40&nbsp;GB**. The index is the figure that matters: held in memory, a miss costs one disk read; evicted, it costs two. → NFR: scale.
- Working set: assume the top 1% of codes carry the bulk of clicks (link popularity is steeply skewed); 10M mappings × ~250 B (cached value only: code and URL, no timestamps or flags, unlike the ~500 B row in the store) ≈ **2.5&nbsp;GB hot** — one cache node's memory, with room for the skew assumption to be wrong by 10×. → NFR: latency.
- Code space: 1B live codes among 62⁶ ≈ 5.7×10¹⁰ slots is **1.8% occupancy** — one random guess in 57 hits a live link. Seven characters (62⁷ ≈ 3.5×10¹²) drops that to **1 in 3,500**, eight to 1 in 218,000. → NFR: unguessability.
- Latency geography: Sydney to a US-east origin is ~16,000&nbsp;km each way — about **160&nbsp;ms round trip** at the speed of light in fibre, before Transport Layer Security (TLS) or a lookup. The budget, not the load, is what forces serving from the reader's own continent. → NFR: latency.

**Verdict per candidate:**

- Event-driven core — **rejected**: no step outlives its request, and the only asynchronous candidate is click analytics, which is out of scope today and would ride beside the redirect rather than inside it. → NFR: latency.
- Synchronous request/response — **adopted**: read, answer, done; a redirect that queues anything has already missed its budget. → NFR: latency.
- Read cache in its own tier — **adopted**: a 2.5&nbsp;GB hot set against 17k reads/s, and mappings are immutable, so a cached entry is never wrong about code → URL, though it can outlive deletion or expiry by up to the edge max-age (300&nbsp;s). → NFR: latency.
- Edge cache — **adopted**: rented, not built; 160&nbsp;ms of physics between continents is not something an origin can optimise away. → NFR: latency.
- Allocator with block claims — **adopted**: distinctness becomes structural, and claiming 1000 ids at a time turns per-write coordination into a few hundred calls a day. → NFR: uniqueness.
- One durable store with a uniqueness constraint — **adopted**: 500&nbsp;GB of immutable rows read only by exact key, and the constraint costs an index the reads already need while being the only thing that arbitrates a custom alias racing an allocated code. → NFR: uniqueness; FR: alias & expiry.
- Keyed permutation before encoding — **adopted**: it is arithmetic, not infrastructure, and without it the code space is a numbered list. → NFR: unguessability.
- Rate limiting on the miss path — **adopted**: probes look exactly like misses, and limiting by source turns a scan from a leak into a bill. → NFR: unguessability.
- Asynchronous standby — **adopted**: availability, not read offload; the price is that links created in the last seconds before a promotion are lost unless the old primary's tail is recovered, and users already hold those short URLs. → NFR: availability.
- Synchronous replication — **rejected**: it pays write latency for a consistency guarantee the requirements explicitly traded away. → NFR: availability.
- Sharding the store — **rejected**: 500&nbsp;GB and ~6 writes/s live on one node, and shards would buy a rebalancing problem no number asks for. Every access is by exact key, so it stays cheap to add later. → NFR: scale.
- Search index — **rejected**: every read is a primary-key lookup, and nobody searches links. → FR: redirect.
- Expiry [sweeper](../patterns/distributed/coordination/sweeper.md) — **rejected**: the read path already evaluates the expiry predicate (410) and the cache already honours a TTL (time to live), so a scheduled job would only be answering a question two components answer for free; reclaiming dead rows stays storage maintenance, not correctness. → FR: alias & expiry.
- Partitioned cache tier — **deferred**: one node holds today's hot set; the trigger is hit ratio sliding as the working set outgrows a single machine's memory. → NFR: latency.
- Click-analytics pipeline — **deferred**: out of scope; the trigger is analytics becoming a requirement, and the constraint it inherits is that ingestion never joins the redirect's critical path. → NFR: latency.

**When this stops being right.** Memory wears out first, in two places at once. The cache holds the hot set only while popularity stays concentrated — as links accumulate and the curve flattens, the hot set grows past one node's RAM, the miss rate climbs, and those misses land on a store whose index has by then also outgrown its memory, turning each one into two random disk reads instead of one. The signal: cache hit ratio and the store's buffer-cache hit ratio falling together while p99 on the redirect climbs — two lines that move before any error does. Exits in adoption order: give the cache node more memory, partition the cache across nodes by code, then partition the store itself, which is cheap here because every access is already an exact-key lookup. → NFR: scale.

## Core entities
<!--meta block=entities-->

Three entities, kept deliberately thin:

- **ShortLink** — the mapping itself, and the only row anything reads: `short_code` (primary key, 7 characters), `long_url`, `created_at`, optional `expires_at`, and a flag recording whether the code was allocated or chosen by the creator.
- **Allocation** — the numeric id a code decodes from. It is not a table: it lives for microseconds inside the write path (claimed block → keyed permutation → base62) and nothing downstream ever sees it, which is what lets a code be opaque without costing a second lookup.
- **User** — the creator, present only so a custom alias and an expiry can be attributed to someone; out of scope beyond that.

## The interface
<!--meta block=interface-->

A small representational state transfer (REST) surface — one verb per requirement:

```http summary="HTTP — create and redirect"
POST /urls
{ "long_url": "https://example.com/some/very/long/path",
  "custom_alias": "optional",
  "expiration_date": "optional" }
→ 200 { "short_url": "https://short.ly/abc123" }
→ 409 Conflict if custom_alias is already taken
→ 400 Bad Request if long_url, custom_alias or expiration_date is invalid

GET /{short_code}
→ 302 Found
  Location: https://example.com/some/very/long/path
  Cache-Control: public, max-age=300
  (410 Gone if the link has expired, 404 if it never existed)
```

The redirect is a **302**, not a 301: a 301 is cached by the browser and never comes back, which would forfeit expiry and any future analytics. 302 keeps every click reaching the service — and that is a cost as well as a choice, because it means the origin tier is sized for every click that misses the edge, not just the first from each browser. With max-age=300 the edge and browser answer repeat clicks for five minutes, so the origin sees a code again only after max-age lapses; a 301 differs by never coming back, not by absorbing the traffic.

`Cache-Control` on the redirect is the one dial the read path hands to machines it does not own. A `max-age` lets the edge answer repeat clicks without asking the origin, and it also bounds staleness in the only direction that matters: a deleted or expired link can keep redirecting for at most one `max-age` after it dies. Keep it in the minutes, and below the link's remaining life.

Creating a link is deliberately not idempotent: two identical `long_url` values get two codes. Deduplicating on the destination would tangle two creators' links together, so one person's expiry would delete another person's link. The [idempotency](../patterns/messaging/idempotency.md) that matters is on the read side, where a mapping never changes once written.

## How the system is built
<!--meta block=architecture-->

Requests enter at two points and take routes with nothing in common. `POST /urls` runs once in a link's life: take the next id from the block this instance already claimed, permute it, encode it, insert one row. `GET /{short_code}` runs for years: the edge answers what it holds, the [shared cache](../patterns/caching/distributed-cache.md) answers what it holds, and only a miss reaches the store. The structural decision is that the two paths share exactly one thing — the store — which is what makes them scale on their own clocks and keeps redirects for cached codes running through a write outage.

```mermaid caption="The write path (generate code → store) is tiny; the read path (edge → cache → store) carries ~600k req/s."
flowchart TB
    Client["Client / browser"]
    Client -->|"POST /urls"| Write["Write Service · stateless-service"]
    Client -->|"GET /{short_code}"| Edge["CDN / edge · cdn"]:::ext
    Edge -->|"edge miss"| Read["Read Service · stateless-service"]
    Write -->|"INCRBY 1000 — claim id block"| Counter[("Id counter · batching")]
    Write -->|"INSERT mapping, UNIQUE short_code"| DB[("URL store")]
    Read -->|"lookup short_code"| Cache[("Cache · cache-aside")]
    Cache -->|"miss"| DB
    DB -->|"async replicate"| Replica[("Read replica · replication")]
    classDef ext stroke-dasharray:4 4;
```

### Components & communication {#architecture-h3-1}

- **Write Service** — the write entry point, serving `POST /urls`; takes the next id from its locally claimed block, permutes it with the shared key, base62-encodes it to 7 characters, and inserts the ShortLink row. Stateless, so instances multiply freely.
- **Read Service** — serves `GET /{short_code}` on an edge miss; resolves the code, collapses concurrent misses for the same code into one store read, and answers a 302 (410 once `expires_at` has passed). Also stateless.
- **Content delivery network (CDN) / edge** — rented, not built: the read path's first hop, near enough to the reader to make the 100&nbsp;ms budget arithmetic rather than hope. Also where per-source limits on the miss rate are applied.
- **Id counter** — one atomic sequence handing out blocks of 1000 rather than single values, so it is touched roughly once per thousand links. It must persist an increment before acknowledging it: a counter that goes backwards issues ids that are already spent.
- **Cache** — hot ShortLink mappings in a shared tier, so every Read Service instance sees the same entries. Mappings are immutable, so the TTL is set by the link's remaining life rather than by any fear of staleness.
- **URL store** — the system of record for ShortLink (500&nbsp;GB of rows and ~40&nbsp;GB of index at 1B links, per Right-sizing); the UNIQUE constraint on `short_code` lives here and arbitrates every duplicate, allocated or chosen.
- **Standby replica** — an asynchronous copy kept warm for promotion, not a query offload.

### Where each requirement lands {#architecture-h3-2}

- Submit a long URL and receive a short one — `POST /urls` → Write Service (id from the claimed block, permuted and encoded) → URL store; the short URL returns in the response, and the counter is touched only when a block runs out. → FR: shorten.
- Choose a custom alias, set an expiry — the same write path: the alias takes the `short_code` slot and the UNIQUE constraint rejects a taken one; `expires_at` is stored on ShortLink and enforced at redirect time (410) and by the cache TTL. → FR: alias & expiry.
- Visit a short URL and be redirected — `GET /{short_code}` enters at the edge; a miss falls through Read Service → Cache → URL store, and the answer is a 302. → FR: redirect.

## Deep dives
<!--meta block=deepdives-->

Four questions decide this design, and two more decide how it survives. How do you hand out names that never repeat? How do you answer a click without touching a disk? How do you stop a stranger guessing the names you gave out? And what happens on the day one link is clicked a million times in a minute?

### 1 · Generating codes that never collide → NFR: uniqueness

**A counter makes distinctness structural: no two writers can be handed the same number, so nothing has to check.** The alternatives are worth walking, because each one fails somewhere different.

- **Naïve — a prefix of the URL.** Take the first characters of the long URL. Two `linkedin.com/in/…` links share a prefix and become the same code, so a visitor lands on a stranger's profile. Rejected on the first collision.
- **Hashing the URL.** Hash the canonicalized URL (SHA-256), base62-encode it, keep the leading characters. It is deterministic, which buys free deduplication — and deduplication is a feature this product does not want, because expiry belongs to the creator (see the interface). A truncated hash also collides by the birthday bound long before the space is full, so it still needs a constraint and bounded retries. Rejected as the primary source.
- **[Counter](../patterns/distributed/coordination/unique-id-generation.md), permuted, then base62 (chosen).** One sequence hands every writer a distinct number, a keyed permutation makes that number opaque (dive 4), and base62 (a–z, A–Z, 0–9) renders it as seven characters that survive a URL — unlike base64's `+` and `/`, which mean other things there. No collision check, because there is no collision to find.
- **Counter durability.** Persisting each increment only helps if the counter store keeps it across failover: Redis replicates and persists asynchronously by default, so fsync each increment or wait for replica acknowledgement, and promote only a replica that confirmed it; otherwise skip the counter forward by a margin on promotion, which costs nothing in a 3.5-trillion space.

The counter is claimed, not called. Each Write Service instance takes 1000 ids with one atomic increment — Redis's `INCRBY` is the usual choice — and then hands them out from its own memory, which turns per-write coordination into a few hundred calls a day. An instance that dies with 400 ids unspent takes them with it, and that costs nothing: the space is 3.5 trillion wide and nobody is counting.

The one thing that must never happen is the counter going backwards. If its node fails over to a replica that missed the last increments, the next instance claims a block that has already been spent, and every insert in that block collides. Two defences do two different jobs: persisting each increment before acknowledging it prevents the storm, and the UNIQUE constraint on `short_code` — hit via a [conditional write](../patterns/distributed/coordination/conditional-write.md) — prevents the corruption if the storm happens anyway. A collision then costs one failed insert and a retry with the next id, never a wrong redirect.

A custom alias is the same insert with the code supplied by the creator instead of the allocator, so one mechanism arbitrates both cases. The loser of the race gets a 409 and picks another alias; an allocated code that happens to land on a taken alias retries with the next id, and nobody notices.

```mermaid caption="Inside the Write Service: ids come from a locally claimed block, are permuted so they carry no order, and only then become a code — the counter is touched once per 1000 links and the UNIQUE constraint is a backstop."
flowchart TB
    subgraph Write["Write Service"]
        Disp["Local id dispenser"]
        Alloc["Range allocator"]
        Perm["Keyed permutation"]
        Enc["Base62 encoder"]
    end
    Disp -->|"block exhausted"| Alloc
    Alloc -->|"INCRBY 1000 — claim next block"| Counter[("Id counter · batching")]
    Disp -->|"next id"| Perm
    Perm -->|"opaque id"| Enc
    Enc -->|"INSERT mapping, UNIQUE short_code"| DB[("URL store · conditional-write")]
```

### 2 · Redirects under 100 ms → NFR: latency

**The budget is spent on geography before it is spent on work.** A round trip between Sydney and a US-east origin costs about 160&nbsp;ms in fibre alone, so a single-origin design misses a 100&nbsp;ms target for half the planet however fast its lookup is. The first tier of the answer is a copy of the mapping near the reader — a [CDN](../patterns/distributed/routing/cdn.md) serving the redirect at the edge — not a faster query at home.

Behind the edge, the lookup has to avoid a disk. An un-indexed lookup is a table scan, fatal at a billion rows, and a B-tree on `short_code` fixes that in principle — but the index is ~40&nbsp;GB and a disk-backed node tops out near ~100k IOPS (input/output operations per second), so what decides the latency is what happens to be resident in memory. A [cache-aside](../patterns/caching/cache-aside.md) tier holding the hot mappings answers a hit in one network round trip to the shared tier, assumed sub-millisecond; a miss adds a random solid-state drive (SSD) read of a few hundred microseconds, so the cache's value is relieving the disk's ~100k IOPS ceiling more than a faster single lookup. Miss the index as well and you pay two of them.

What makes this cache unusually easy is that a mapping never changes. There is no invalidation protocol here, only expiry and deletion (which purges the shared cache while edge copies age out within `max-age`): an entry can be held for the whole life of the link, and a TTL at or below `expires_at` retires it without anyone sending a message. That [immutability](../patterns/functional/immutability.md) is why three tiers of copy stack up without a consistency argument at every boundary — the only question at each hop is whether the entry is there, never whether it is right.

```mermaid caption="What does one redirect touch? Edge serves hot codes; otherwise a cache-aside lookup, and only a miss reaches the store — which then backfills the cache."
sequenceDiagram
    autonumber
    participant C as Client
    participant E as CDN edge · cdn
    participant R as Read Service
    participant K as Cache · cache-aside
    participant D as URL store
    C->>E: GET /{short_code}
    alt hot code at edge
        E-->>C: 302 redirect
    else edge miss
        E->>R: forward request
        R->>K: lookup code
        alt cache hit
            K-->>R: long URL
        else cache miss
            K-->>R: absent
            R->>D: SELECT by short_code
            D-->>R: long URL
            R->>K: backfill, TTL ≤ expiry
        end
        R-->>C: 302 redirect
    end
```

### 3 · The one link everybody clicks → NFR: latency; availability

**A cache sized for the average is defeated by a single [hot key](../hazards/hot-key.md).** A link in a television advert is not more traffic spread evenly; it is one row asked for hundreds of thousands of times a second.

The failure is a [cache stampede](../hazards/cache-stampede.md), and it arrives on a schedule. Every edge location holds the hot code under the same TTL, so they all expire within a second of each other. Every one of them then misses, every miss becomes a request to the Read Service, and every one of those becomes a read of the same row — so a store that was serving a few hundred reads a second is asked for one row by every point of presence on the planet at once. Five defences, of which three are taken:

- **Hold it longer where you can invalidate it.** The shared cache is ours to delete from, so an immutable mapping can sit there for hours or for the link's whole remaining life, and the expiry that starts a stampede happens far less often; the edge copy keeps the minutes-scale `max-age` from the interface, because purging every point of presence is best-effort. Chosen, and the cheapest of the five.
- **Serve stale while refreshing.** The edge answers from the just-expired copy and refreshes behind the response, so no click waits on the origin and the refresh is one request rather than a herd. Chosen.
- **Collapse concurrent misses.** The Read Service keeps one in-flight fill per code and parks the other requests on it, so the store sees one read per code per fill however many arrive. Chosen — it bounds the blast radius instead of reducing the odds, which is what you want for the day the other two fail together. Collapsing is per instance, so with N Read Service instances the store sees up to N reads per code per fill.
- **Refresh hot keys before they expire.** [Refresh-ahead](../patterns/caching/refresh-ahead.md) needs a list of what is hot, and popularity moves faster than a list built from yesterday's traffic. Deferred until hot codes are being measured anyway.
- Replicating the hot key across cache nodes is deferred too: it addresses one cache node's network card, and a key hot enough to saturate that never gets past the edge to reach it.

The residual is the cold start. A cache tier that comes back empty puts the full sustained rate — ~17k reads/s — on the store as single-row lookups, which is survivable while the index is in memory and unpleasant if it is not. Collapsing misses does the staging for free: the first request for each code fills it, the rest wait a millisecond behind it, and the store sees one read per distinct code per instance rather than one per client.

```mermaid caption="One expiry, N misses, one read: a single in-flight fill per code is what keeps a viral link from turning every edge miss into a database read."
sequenceDiagram
    autonumber
    participant E as Edge PoPs · many
    participant R as Read Service
    participant K as Cache · cache-aside
    participant D as URL store
    Note over E,K: TTL on the viral code expires everywhere at once
    E->>R: N concurrent misses, same code
    R->>K: lookup code
    K-->>R: absent
    R->>D: one read — later arrivals wait on it
    D-->>R: long URL
    R->>K: backfill, TTL = remaining life
    R-->>E: 302 to all N waiters
```

### 4 · Codes that cannot be walked → NFR: unguessability

**A short code is a password nobody chose, so its only defence is how much of the space is empty.** Occupancy, not cleverness, is the security parameter — and it is set by a decision that looks purely cosmetic: how many characters long the code is.

Do that arithmetic before picking the length. A billion live codes among the 62⁶ ≈ 5.7×10¹⁰ slots of a six-character code is 1.8% occupancy: one random guess in 57 lands on a real link, so a single machine sending a thousand probes a second harvests around eighteen live destinations a second. Seven characters take that to 1 in 3,500 and eight to 1 in 218,000, which is why this design generates seven-character codes even though six would hold the billion. The extra character costs one byte per row and buys two orders of magnitude of dilution.

Sparse is still not enough, because a counter is a numbered list. Base62 is a notation, not a cipher: encode 1,000,000 and 1,000,001 and you get neighbours, so anyone holding one code can read the one issued just after it. Permute the id with a keyed bijection (a reversible one-to-one scramble) before encoding — a small Feistel network, the construction behind format-preserving encryption. It is one-to-one, so distinctness survives the transform; multiplication by an odd constant modulo 2ⁿ is also one-to-one but only scrambles (see the note below) and no collision check appears. A plain XOR with a secret is the tempting version and the wrong one: it flips fixed bits, so consecutive ids stay consecutive in the low bits and the codes still cluster.

Then make probing expensive. A scan shows up as an unusual miss rate from one source, so apply a [rate limit](../patterns/distributed/resilience/rate-limiter.md) keyed on source at the edge, and cache negative answers so a scan cannot convert itself into store reads while it runs. And unguessable is not private. Whoever holds the link holds the content, and there is no revocation short of deletion or expiry — a link that must stay private needs authentication at the destination, which is a different product.

- Odd-constant multiplication is linear: two known code pairs reveal the multiplier and consecutive ids stay a fixed stride apart, so it scrambles without hiding. Use the Feistel network; a permutation over 2ⁿ ids fits seven base62 characters only while n ≤ 41 (62⁷ ≈ 3.5×10¹² exceeds 2⁴¹ ≈ 2.2×10¹², not 2⁴²), so cycle-walk if ids can exceed that. The key stays fixed for the life of the data: a new key would map fresh ids onto codes already issued. Dive 6's ranges (A from 0, B from 10¹²) leave region B about 1.2×10¹² ids below 2⁴¹, so a third region needs cycle-walking.

### 5 · Staying up through failures → NFR: availability

**99.99% here means one warm copy of everything, plus an honest account of what each failure costs.** The read path and the write path fail very differently, and only one of those failures is visible to the people following links.

For the store, synchronous replication is rejected: it pays write latency for a consistency guarantee the requirements traded away. What remains is a single primary with an asynchronous [standby](../patterns/distributed/coordination/replication.md), promoted when the primary dies. Redirects continue throughout, because the edge and the cache are already answering nearly all of them and the promoted node picks up the rest. What stops is creation — at ~6 writes/s, a two-minute promotion costs on the order of seven hundred link creations, which clients retry — and the residual is replication lag, so a link created seconds before the failure can be briefly missing after it. The requirements accept both.

The other stateful pieces degrade more gently. Losing a cache node is a miss storm rather than an outage: the store sees the sustained rate instead of the leftovers, and the one-fill-per-code rule from dive 3 keeps the refill from arriving all at once. Losing the counter's node costs the unspent tail of a few claimed blocks, which is free — uniqueness never needed an unbroken sequence — provided the counter cannot come back holding a lower value than it already gave out (dive 1).

```mermaid caption="Availability is one warm copy: the replica trails the primary by moments and takes over when it dies — the seconds of lag are the accepted consistency cost."
flowchart TB
    Write["Write Service"] -->|"INSERT mapping"| DB[("URL store")]
    Read["Read Service"] -->|"SELECT on cache miss"| DB
    DB -->|"async replication stream"| Replica[("Read replica · replication")]
    Replica -.->|"promoted to primary on failure"| DB
```

### 6 · Scaling out: what multiplies and what stays single → NFR: scale

**Everything on the read path multiplies, and the design's only coordination point is touched a few hundred times a day.** What is left is not a capacity problem but a set of decisions about where the copies live.

Serving tiers are [stateless](../patterns/distributed/routing/stateless-service.md), so they grow by adding instances, and each region gets its own edge and its own cache because that is where the latency budget is spent. The store needs no such treatment: at ~6 writes/s a single writable primary anywhere on earth is enough, and creating a link is the one operation here that nobody minds waiting 200&nbsp;ms for. That is what multi-region means on this page — latency geography for reads, not capacity for writes.

The counter is the piece that would otherwise coordinate across a wide area network (WAN), so it does not: give each region a disjoint range (region A from 0, region B from 10¹²) and writers never contend across an ocean, with [batched](../patterns/concurrency/batching.md) block claims making each region's counter nearly idle. If write volume ever did demand regional primaries, the exit is to partition by code, which is cheap because every access is already an exact-key lookup. Keep that region map in the routing tier rather than encoding a region prefix in the code itself — the code is deliberately opaque (dive 4), and a routable prefix would hand back the structure the permutation exists to remove.

```mermaid caption="Scale-out without WAN coordination: each region owns a disjoint counter range, so write instances multiply and never contend across regions; the store stays single."
flowchart TB
    subgraph RA["Region A — counter range 0–1T"]
        WA["Write Service ×N · stateless-service"]
        CA[("Id counter A · batching")]
    end
    subgraph RB["Region B — counter range 1T–2T"]
        WB["Write Service ×N · stateless-service"]
        CB[("Id counter B · batching")]
    end
    WA -->|"INCRBY 1000"| CA
    WB -->|"INCRBY 1000"| CB
    WA -->|"INSERT mapping"| DB[("URL store")]
    WB -->|"INSERT mapping"| DB
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The biggest flaw, named first: one primary store and one id counter mean a single write path, kept on purpose instead of sharded.** Following links survives almost anything; making them does not.

### Strengths
<!--meta polarity=pro-->

- **Distinctness is structural.** Codes come from claimed counter blocks, so no writer ever reads before it writes.
- **The hot path never changes state.** A mapping is immutable once written, so every tier of copy is governed by a TTL rather than an invalidation protocol.
- **The store is small enough to be boring.** 500&nbsp;GB and a handful of writes a second on a single node — no shard map, no rebalancing, no cross-partition anything.
- **Sharding stays cheap to add later.** Every access is an exact-key lookup, so partitioning is a hash away on the day a number finally asks for it.
- Seven-character keyed codes leave the space 0.03% occupied, so scanning it returns almost nothing.
- A new region is an edge, a cache and a counter range — additive, with no consensus group to join.

### Risks
<!--meta polarity=con-->

- **The write path is a single point of failure.** A primary failover stops link creation until promotion completes, while redirects continue from cache and edge (see dive 5).
- **The counter must never go backwards.** A failover that loses acknowledged increments re-issues spent ids, and the constraint turns that into failed writes until the allocator is repaired (see dive 1).
- **A viral code concentrates on one key.** One expiry can put every edge miss on a single row at the same instant (see dive 3).
- **Unguessable is not private.** Whoever holds a link holds the content, and there is no revocation short of deletion or expiry (see dive 4).
- A link created seconds before a failover can be lost after it unless the old primary's tail is recovered, and its creator already holds the short URL: availability bought with consistency, by requirement.
- Answering 302 keeps every click at the origin, so the read tier is sized for repeat visits a 301 would have absorbed in the browser.
- A deleted or expired link is purged from the shared cache but keeps redirecting from edge copies for up to `max-age` (300&nbsp;s), so the `max-age` chosen on the redirect is also the staleness budget.

## What's expected at each level
<!--meta block=levels-->

### Mid-level {#levels-h3-1}

- Asks how many links are made against how many are followed, before drawing anything.
- Produces a working end-to-end flow — submit, generate, store, redirect — and defends one uniqueness scheme.
- Chooses 302 over 301 and says what the choice keeps rather than that it is standard.
- Reaches for a cache when told reads dominate, and can say what a miss costs.

### Senior {#levels-h3-2}

- Sizes the store before reaching for shards, and drops sharding once the number says so.
- Argues counter against hash on collision policy and deduplication, not on taste.
- Designs the read path as tiers and states what each one absorbs.
- Treats a viral link as its own failure mode rather than as a larger average.

### Staff+ {#levels-h3-3}

- Prices the code space against occupancy before choosing a code length.
- Separates latency geography from write capacity when arguing for multiple regions.
- Names the id allocator as the design's coordination point and states its failover semantics unprompted.
- Defends the single write path as the design's biggest flaw, chosen deliberately, and prices the exit.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Cache Stampede](../hazards/cache-stampede.md) — Every edge location holds a hot code under the same TTL, so expiries line up and every miss becomes a read of the same row.
- [Hot Key](../hazards/hot-key.md) — Can fall into hot key when one viral code puts hundreds of thousands of reads a second on a single row

**Demonstrates**

- [Cache-Aside](../patterns/caching/cache-aside.md) — Redis in front of the store serves the hot working set; misses fall through to the database
- [CDN](../patterns/distributed/routing/cdn.md) — Popular codes and their redirects are pushed to the edge so they never reach the origin
- [Replication](../patterns/distributed/coordination/replication.md) — An asynchronous standby gives the single URL store failover without sharding
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — Write and read services scale horizontally because instances hold no per-request state
- [Conditional Write](../patterns/distributed/coordination/conditional-write.md) — A UNIQUE constraint on short_code is the final backstop against a duplicate code
- [Batching](../patterns/concurrency/batching.md) — Write instances claim counter values in blocks of 1000, cutting allocator round-trips 1000×
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Per-source limits on the miss rate at the edge stop a scanner turning guessed codes into store reads
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Hot mappings live in a shared cache tier, so every Read Service instance sees the same entries and one fill serves them all
- [Immutability](../patterns/functional/immutability.md) — A short code never changes its long URL, so cached copies need only a time to live (TTL) and no invalidation protocol
- [Unique ID Generation](../patterns/distributed/coordination/unique-id-generation.md) — Claimed counter blocks, a keyed permutation and base62 give collision-free codes with no check; hashing and random codes are the rejected alternatives.

<!-- relationships:end -->
