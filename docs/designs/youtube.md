---
title: YouTube
description: "Take a 10-GB upload straight to blob storage, transcode it into segments, and stream it worldwide with adaptive bitrate"
area: designs-advanced
owner: Oleksandr Derechei
tags: [scalability, availability, throughput, latency]
status: stable
aliases: [video streaming platform, video sharing service]
solves: [users upload multi-gigabyte files and my app servers fall over trying to proxy every byte, a viewer on a spotty connection keeps buffering because I only stored one giant video file, when an upload drops at 90% the user has to start the whole thing over from scratch, one clip goes viral and the single database node holding its record melts under the read load, transcoding a long video into every device format takes forever on a single machine]
favourite: true
---

# YouTube

A video platform accepts a file from one person and plays it back to everyone else. The surface is small and the load is not: the file is tens of gigabytes, the viewer's bandwidth moves while they watch, and one clip is read a hundred thousand times for every time it is written. Every decision on this page is about which of those bytes you touch, and where.

## Understanding the problem
<!--meta block=description-->

A video platform accepts a file of tens of gigabytes, then stores, converts and serves it for years. Upload happens once and takes minutes; playback happens up to millions of times, starts in about two seconds and runs over unmeasured connections. The page walks through getting bytes in, converting each upload into a ladder of qualities, serving from near viewers, and protecting hot records. It is the entry point for the Streaming theme.

## Explained
<!--meta block=explain-->

YouTube-style video is sized by bytes moved, not by requests: 1 million uploads a day is only 12 a second, yet it stores about 1.7 PB and plays about 5.6 PB. Uploads go straight from the client into object storage in parts, so no application server carries a byte, and converting a video runs as small segment jobs on a [queue](../patterns/messaging/message-queue.md). Playback is plain cacheable file fetches from a content delivery network ([CDN](../patterns/distributed/routing/cdn.md), a rented network of servers near viewers). Choose a queue over converting inside the upload request, because converting ten minutes of video takes over a thousand core-seconds and a dropped connection at 90% would lose everything.

- **Not watchable yet.** A video is not playable until its last segment is done. Show a processing state; use separate queues by upload length.
- **CDN failure.** If the CDN fails, the origin gets about 20 times its load. Contract a second CDN.
- **Endless storage.** Storage grows daily and is never deleted. Copy only the original to a second region; rebuild the rest.

**Example.** A 10 GB master goes up in 10 MB parts, about 1,000 of them, and the server handles only the part list. Playback totals 100 million watches times 300 s times 1.5 Mbit/s, about 5.6 PB a day, or 520 Gbit/s. With a 95 percent CDN hit ratio the origin serves 26 Gbit/s. If the CDN went down, the origin would face the full 520, 20 times its design. The cost is that a lost CDN is an origin overload, not a slowdown. If the connection drops at part 900, the part list shows 100 unmarked parts and only those are sent again.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. A user uploads a video file with a title and a description.
2. A user resumes an interrupted upload without re-sending the parts that already landed.
3. A user sees whether an uploaded video is still processing or ready to watch.
4. A user watches a video at a quality their connection can sustain.
5. A watch counts toward the video's view total.

Out of scope: search, comments, recommendations, channel subscriptions, live streaming, monetisation and moderation — named explicitly so the design stays on upload, processing and playback. {#requirements-scope-1}

### Non-functional
<!--meta requirement=nfr-->

- **Scale**
  - 1M uploads and 100M watches a day, roughly 100 watches per upload.
  - Popularity is concentrated: a small share of the catalogue takes most of the watches. {#requirements-nfr-scale-2}
  - One viral clip's record must not overload the single storage node holding it. {#requirements-nfr-scale-3}
- **Throughput**
  - A single upload can be tens of gigabytes and hours long.
  - Bytes moved, not requests served, is the axis the system is sized on. {#requirements-nfr-throughput-2}
- **Latency**
  - Playback starts in about two seconds.
  - Playback does not stall when the viewer's bandwidth halves mid-watch. {#requirements-nfr-latency-2}
  - A viewer on another continent pays no extra round trip on each of the seventy-odd fetches a watch takes. {#requirements-nfr-latency-3}
- **Availability & resilience**
  - 99.9% for playback, favoured over consistency; a video minutes late is acceptable, playback going dark is not.
  - Every failed processing step retries or ends with a recorded reason the uploader can see. {#requirements-nfr-resilience-2}
- **Durability** — an accepted upload's original file is never lost; copies made from it may be rebuilt rather than replicated.

## Right-sizing
<!--meta block=sizing-->

Two kinds of number decide this design and they point opposite ways. One is how many things happen — a million uploads and a hundred million watches a day, which for a computer is barely anything. The other is how many bytes move to make them happen, and that one is enormous. Everything here spends money to move bytes as few times, and as short a distance, as it can.

**The problem:** a million uploads and a hundred million watches a day, where the load that decides the architecture is bytes moved rather than requests served. **The shape:** event-driven writes, synchronous reads — converting one upload is over a thousand core-seconds that cannot sit inside a request, it arrives in bursts the workers should absorb, and completion is a fact told to the pipeline exactly once; a segment fetch changes no state and is answered in one hop. **The stores:** five that we run — the blob store, the metadata store, a durable work queue, the orchestrator's own workflow history, and a read cache in front of the metadata store — plus a rented edge cache, capacity bought rather than operated.

**Required capabilities:**

- Object store for large immutable blobs — a master of tens of GB per upload plus every segment built from it, written once and read by URL. → non-functional requirement (NFR): throughput; functional requirement (FR): upload.
- Short-lived scoped write tokens — the client writes into that store directly, without the bytes crossing an application tier. → NFR: throughput; FR: upload.
- Durable work queue feeding an elastic compute pool — transcode work must survive a worker dying mid-job, and the pool is sized in thousands of cores. → NFR: throughput; availability & resilience.
- Workflow state that outlives a process — a video is finished only when its last segment is. → NFR: availability & resilience; FR: state.
- Poison-job quarantine — a file that crashes the encoder must stop being retried and become visible. → NFR: availability & resilience.
- Partitioned metadata store keyed by video — 365M new rows a year, read only by exact key. → NFR: scale; FR: watch.
- Read cache in its own tier — a viral clip's row is read thousands of times a second while every other row is read once. → NFR: scale.
- Edge cache near the viewer — the latency budget goes on distance before work, and is spent per segment rather than per watch. → NFR: latency.
- Counter aggregation — a hundred million increments a day on a few videos, none worth a durable write alone. → FR: views.
- Cross-region copy of the master — the one artifact here that cannot be recomputed. → NFR: durability.

**The numbers:**

- Ingest: 1M uploads/day is **12 upload starts/s**, a rate that decides nothing — but × ~1&nbsp;GB average master (assumed: ten minutes at a consumer ~10&nbsp;Mbit/s is 0.75&nbsp;GB, rounded up for longer files) ≈ **~95 Gbit/s inbound**, ~290 at peak. The second figure is what removes the application tier from the byte path. → NFR: scale; throughput.
- Storage per hour of video: a five-rung ladder — 240p 0.3, 360p 0.6, 480p 1, 720p 2.5, 1080p 5&nbsp;Mbit/s — sums to 9.4&nbsp;Mbit/s ≈ **4.2&nbsp;GB/hour of finished video** against 4.5&nbsp;GB/hour for the master alone; one 4K rung at ~18&nbsp;Mbit/s adds 8.1&nbsp;GB/hour, more than the five below it combined. → NFR: throughput.
- New bytes stored: ~1&nbsp;GB of master plus ~0.7&nbsp;GB of ladder per ten-minute upload ≈ **~1.7&nbsp;PB/day**, ~600&nbsp;PB a year, never deleted — an accumulating figure, not a rate. → NFR: durability.
- Object count: ten minutes at four-second segments is 150 objects per rendition, × 5 renditions plus audio and manifests ≈ **~800 objects per upload**, ~800M a day. Object stores charge per request as well as per byte, so segment duration is a cost dial. → NFR: throughput.
- Transcode compute: 600M video-seconds/day × ~2 core-seconds each for the ladder (assumed: the 1080p rung dominates) ≈ **~14,000 cores flat out**, or nearer 40,000 if sized for the peak hour instead of queued across the day. → NFR: throughput.
- Read fan-out: a five-minute session (assumed median) pulls one manifest and ~75 segments; × 100M watches ≈ **~88k requests/s at the edge** against **~1,200 metadata reads/s**, both tripling at peak. → NFR: scale.
- Egress: 100M watches × 300&nbsp;s × ~1.5&nbsp;Mbit/s delivered on average (assumed: a mobile-heavy audience settles below the top rung) ≈ **~5.6&nbsp;PB/day ≈ 520 Gbit/s**. At a 95% edge hit ratio (assumed: measured by bytes served; at 90% the origin serves ~52 Gbit/s, twice as much) the origin serves ~26 Gbit/s of it. → NFR: latency; throughput.
- Metadata storage: 365M rows/year × ~1&nbsp;KB ≈ **365&nbsp;GB/year** — free, except while an upload runs, when a 10&nbsp;GB master at 10&nbsp;MB parts carries a ~120&nbsp;KB part list, a hundred times the finished row. → NFR: scale.
- Latency geography: a viewer 15,000&nbsp;km away pays ~150&nbsp;ms per round trip in fibre; across 76 fetches that is **~11&nbsp;s of pure round-trip time** inside a five-minute watch. → NFR: latency.

**Verdict per candidate:**

- Synchronous request/response on the write path — **rejected**: converting ten minutes of video is over a thousand core-seconds, so nothing can wait inside a request. → NFR: throughput.
- Event-driven write path on a durable queue — **adopted**: completion is one fact told once to a pipeline that owns the work, and the queue turns a 14,000-core appetite into a fleet sized a little above the mean, so a backlog drains instead of only queueing. → NFR: throughput; availability & resilience.
- Synchronous request/response on the read path — **adopted**: a segment fetch is a cacheable GET with no state change to announce. → NFR: latency.
- Object store — **adopted**: 1.7&nbsp;PB a day of write-once, read-by-URL blobs, and no other tier answers that shape. → NFR: throughput.
- Scoped upload tokens — **adopted**: 95 Gbit/s of inbound that never touches an application process, paid for by trusting the store to enforce the token. → NFR: throughput; FR: upload.
- Workflow orchestrator — **adopted**: fan-out to hundreds of segments, [fan-in](../patterns/messaging/fan-in.md) on the last, retries and timers; hand-rolling it means a counter row and a scheduler you will rebuild badly. → NFR: availability & resilience; FR: state.
- Dead-letter channel — **adopted**: a file that crashes the encoder is otherwise retried forever, and the fleet spends real cores discovering that. → NFR: availability & resilience.
- Separate queues by job size, plus a per-account upload cap — **adopted**: one FIFO (first in, first out) puts a ninety-second clip behind a twelve-hour upload, and no account should claim the fleet. → NFR: throughput.
- Partitioned key-value metadata store rather than a relational primary — **adopted**: 365M rows a year, every access an exact-key lookup, nothing to join. → NFR: scale.
- Read cache in its own tier — **adopted**: 1,200 reads/s is nothing spread evenly and everything when one row takes most of it. → NFR: scale.
- Edge cache — **adopted**: rented, not built; it turns 520 Gbit/s of egress into 26 and 11&nbsp;s of round-trip time into one continent's worth. → NFR: latency.
- A durable write per view — **rejected**: 1,200 increments/s on a handful of rows is a write hot spot bought for a number nobody reads precisely. → FR: views.
- Aggregated view counters — **adopted**: tally in the serving tier, flush deltas on an interval, accept that the total trails by it. → FR: views.
- Cross-region copy of the master but not the renditions — **adopted** for the master, which cannot be recomputed; **rejected** for the ladder, where rebuilding is compute scheduled once against storage billed monthly. → NFR: durability.
- Search index — **rejected**: search is out of scope and every read here is by video id. → NFR: scale.
- A custom streaming protocol — **rejected**: plain HTTP segments are what lets a rented edge carry playback. → NFR: latency.
- Hardware transcoding — **deferred**: software encoding is easier to schedule and change; the trigger is transcode passing storage in the monthly bill. → NFR: throughput.
- Just-in-time packaging of the top rungs — **deferred**: it cuts storage and pays with a slow first watch; the trigger is the share of renditions never requested in 90 days passing a quarter. → NFR: durability.

**When this stops being right.** Nothing here fails as it grows — the bill does. Every day adds ~800M objects and ~1.7&nbsp;PB that are never deleted, and object stores charge per request as well as per byte, so both recur every month while the income paying for them tracks only what people watched today. The cost curve follows the accumulated catalogue, the revenue curve follows new watches, and the two diverge from the first day. The signal is the share of stored renditions with no request in 90 days, read next to bytes stored per watch-hour delivered. Exits in adoption order: cold-store each master once its ladder is published; build the top rungs on first request rather than eagerly; then re-encode the cold catalogue with a more efficient codec. → NFR: durability.

## Core entities
<!--meta block=entities-->

Six entities, and the split between two of them carries the design:

- **User** — an uploader or a viewer, present so a video has an owner and an uploader can see the state of their own upload.
- **Video** — the logical asset: the master as it arrived plus every rendition built from it. Nothing reads a Video directly; everything reads one of the records below.
- **VideoMetadata** — the row every watch reads: `videoId`, `uploaderId`, title, duration, `state` (Uploading → Processing → Playable → Failed) and the manifest URL. While the upload runs it also carries the part list, the largest thing in the row and dead weight the moment the upload completes.
- **Segment** — a few seconds of one rendition, its own object under a key built from `videoId`, rendition and sequence number. Computed rather than allocated, which is what makes a retried transcode overwrite its own output.
- **Manifest** — the streaming index: a primary manifest listing the renditions, and one media manifest per rendition listing its segments in order. Once the player has it, it never asks us anything again.
- **ViewCount** — the per-video total, kept out of VideoMetadata because it is written far more often than the row is read, and it is the only value here allowed to be slightly wrong.

## The interface
<!--meta block=interface-->

Five endpoints, and both halves of the product do the same thing: hand back a URL and get out of the byte path.

```http summary="HTTP — request a slot, track parts, complete, watch"
POST /videos
{ "title": "...", "description": "...", "size_bytes": 10737418240, "part_size": 10485760,
  "parts": [{ "number": 1, "fingerprint": "sha256:..." }, ...] }
→ 201 { "video_id": "...", "state": "Uploading",
        "upload_urls": [{ "number": 1, "url": "https://blob.example/...?sig=..." }, ...] }
      (the client then PUTs each part straight to the blob store)

PATCH /videos/{video_id}/parts
{ "number": 3, "etag": "..." }        // relay the store's ack so the server marks the part landed
→ 200 { "landed": 3, "of": 1024 }

POST /videos/{video_id}/complete
→ 202 Accepted { "state": "Processing" }   // repeating this returns the same state, never a second pipeline
      (409 Conflict + the list of part numbers still missing)

GET /videos/{video_id}
→ 200 { "state": "Playable", "manifest_url": "https://cdn.example/{id}/primary.m3u8", ... }
→ 200 { "state": "Processing", "progress": 0.42 }   // while the pipeline runs
→ 200 { "state": "Uploading", "parts": [...], "upload_urls": [fresh scoped URLs for the unmarked parts only] }   // a resume asks here after the first URLs expire
      (404 if it never existed, 410 if it was removed)

POST /videos/{video_id}/views
→ 202 Accepted                    // counted off the playback path; the only call the player may drop
```

Note what appears in no request or response body: video bytes. `POST /videos` returns write URLs the client uses against the store directly, and `GET /videos/{video_id}` returns a manifest URL pointing at the edge. The application tier issues locations and never carries content — which is why ~95 Gbit/s inbound and ~520 Gbit/s outbound never appear on a graph of its network usage. A resume re-issues scoped URLs for unmarked parts only; the token lifetime is a deployment setting.

`POST /videos/{video_id}/complete` answers **202 Accepted** rather than 200, because the work it starts outlives the request by minutes. That is also why `state` is a field rather than something the client infers: an uploader who has finished their part needs to see that the system has not. Repeating the call returns the current state and starts nothing, and its `409` carries the part numbers still missing — so recovery is a call the client already makes.

`POST /videos/{video_id}/views` is its own call answering 202, and the only request whose failure the player may ignore. Counting a view inside the playback path would put a write in front of the thing the design exists to make fast — a dropped view costs a number, a delayed first frame costs the viewer.

## How the system is built
<!--meta block=architecture-->

Requests enter at one gateway and split into two paths sharing nothing but a video id. The write path is asynchronous: the Video Service records a row, issues scoped upload URLs and steps aside while the client's bytes go straight into the blob store, and the store's completion event hands the work to a pipeline that owns it for minutes. The read path is synchronous and mostly not ours: one cached metadata lookup gives the player a manifest URL, and every byte after that comes from the edge. The structural decision is that no application process ever holds a video byte, which is what lets a tier sized for ~3,500 requests/s sit in front of half a terabit of traffic.

```mermaid caption="Bytes bypass the application tier on the way in (scoped upload URLs) and on the way out (the edge); the Video Service only ever moves metadata."
flowchart TB
    Client["Client / player"]
    Gateway["API Gateway · api-gateway"]
    Video["Video Service · stateless-service"]
    Cache[("Metadata cache · cache-aside")]
    Meta[("Metadata store · sharding")]
    Blob[("Blob store · object-storage")]
    Pipeline["Processing pipeline · workflow-orchestration"]
    Edge["CDN / edge · cdn"]:::ext

    Client -->|"POST /videos, GET /videos/{id}"| Gateway
    Gateway -->|"authenticate, rate limit, route"| Video
    Video -->|"lookup videoId"| Cache
    Video -->|"on a miss: read the row, then populate"| Meta
    Video -->|"issue scoped upload URLs · valet-key"| Blob
    Client -->|"PUT parts — bytes skip the app tier"| Blob
    Blob -->|"upload complete event"| Pipeline
    Pipeline -->|"renditions + manifests"| Blob
    Pipeline -->|"state = Playable"| Meta
    Client -->|"GET manifest, GET segments"| Edge
    Edge -->|"fill on miss"| Blob
    classDef ext stroke-dasharray:4 4;
```

### Components & communication {#architecture-h3-1}

- **API Gateway** — the single [entry point](../patterns/distributed/routing/api-gateway.md): terminates Transport Layer Security (TLS), authenticates the uploader, and applies the per-account limits that stop one uploader claiming the transcode fleet.
- **Video Service** — serves all five endpoints: reads and writes VideoMetadata, issues scoped upload URLs, returns the manifest URL on a watch. It is [stateless](../patterns/distributed/routing/stateless-service.md), so instances multiply behind the gateway.
- **Metadata cache** — hot VideoMetadata rows in a shared tier, so every Video Service instance sees the same entries. The Video Service owns the fill: it looks the row up here, and on a miss reads the store itself and writes what it found back — [cache-aside](../patterns/caching/cache-aside.md), so the cache is never in the path of a write. A row stops changing once the video is Playable, so its TTL (time to live) is a memory-budget decision.
- **Metadata store** — the system of record for VideoMetadata and ViewCount, partitioned by `videoId` (365&nbsp;GB/year of rows, per Right-sizing). Every access is an exact-key lookup.
- **Blob store** — masters, segments and manifests, written once and read by URL. It is also the write path's event source: completing a multipart upload emits exactly one object-level event.
- **Processing pipeline** — the orchestrator and its transcode workers; consumes the completion event, fans out one job per segment per rendition, writes renditions and manifests back to the blob store, and flips `state` to Playable.
- **CDN / edge** — rented, not built: serves manifests and segments from near the viewer, fills from the blob store on a miss, and answers ~95% of the design's egress.
- **Client / player** — a heavy participant by design: splits the upload into parts, retries them, reads the manifest, and chooses which rendition to pull next.

### Where each requirement lands {#architecture-h3-2}

- Upload a video file with a title and description — `POST /videos` → Video Service → Metadata store for the row, then Client → Blob store for the bytes. → FR: upload.
- Resume an interrupted upload — `PATCH /videos/{id}/parts` → Video Service → Metadata store records each acknowledged part, and `GET /videos/{id}` returns the list the client needs to work out what is left. → FR: resume.
- See whether a video is processing or ready — `state` on VideoMetadata, written by the Processing pipeline and read back through Metadata cache → Video Service. → FR: state.
- Watch at a quality the connection sustains — `GET /videos/{id}` → Video Service returns the manifest URL; the player then goes Client → CDN for the manifest and every segment. → FR: watch.
- Count a watch toward the video's total — `POST /videos/{id}/views` → Video Service tallies in memory and flushes deltas → Metadata store. → FR: views.

## Deep dives
<!--meta block=deepdives-->

Five questions decide this design. How do you get a ten-gigabyte file in without an application server carrying it? How do you turn one file into something a phone on a train can play? How do you reach a viewer on the other side of the world without them waiting? What happens the day one clip is watched by everybody at once? And what is worth keeping forever?

### 1 · Getting tens of gigabytes in → NFR: throughput

**Take the application tier out of the byte path and the size of an upload stops being your problem — it becomes the object store's, which is built for exactly this.** Three ways to accept a file, and the first two fail on different numbers.

- **Naïve — POST the file to an endpoint.** One process is pinned for the whole transfer, the file has to live somewhere while it arrives, and a drop at 90% has produced nothing. At ~95 Gbit/s that is a tier paid for carrying bytes it never reads.
- **Chunk it, but through the application tier.** Resuming works, and the bandwidth bill does not move: every byte still crosses a process you run and a network you pay for, twice.
- **Scoped write URLs straight into the store (chosen).** The client asks for a slot, gets a [time-limited token](../patterns/distributed/routing/valet-key.md) per part, and PUTs the bytes into [object storage](../patterns/distributed/routing/object-storage.md) itself. The application tier handles a few hundred bytes of JSON per gigabyte transferred.

Resuming falls out of tracking the parts. The client splits at a fixed part size — 5–10&nbsp;MB is usual, so a 10&nbsp;GB master is around a thousand parts — fingerprints each, and registers the list on VideoMetadata before sending anything. The store acknowledges each part with an ETag, the client relays it, the server marks the part landed. A resume is a diff: read the row, send what is unmarked, complete.

Two checksums do two different jobs. The store's ETag proves what the store received; the client's fingerprint proves what the client meant to send. Together they catch a corrupted part and a client that re-split the file differently between attempts — when boundaries move, every fingerprint after the change misses, and the honest answer is to restart. That is why part size is fixed at creation and recorded on the row.

Completion is one call and one event: the store emits a single object-level notification once the multipart upload is assembled, and that event starts the pipeline — an [idempotent trigger](../patterns/messaging/idempotency.md), so a retried `complete` never runs the work twice. Name the failure branch. If the event is lost the video sits in Processing until someone complains, and an event source you do not own has no retry you can see — so a [sweeper](../patterns/distributed/coordination/sweeper.md) over rows stuck past a threshold is what closes the gap.

The residual is that the client is a participant rather than a caller, and an abandoned client is an upload that never finishes. Object stores keep the parts of an incomplete multipart upload and charge for them, so those bytes pile up as storage that appears in no listing of videos. A lifecycle rule aborting stale uploads is not optional.

```mermaid caption="What does a resumable upload cost the server? One row, one ack per part, and no bytes — the client talks to the store for everything that is large."
sequenceDiagram
    autonumber
    participant C as Client
    participant V as Video Service
    participant M as Metadata store
    participant B as Blob store · object-storage
    C->>V: POST /videos — title, part list
    V->>M: INSERT row, state = Uploading
    V-->>C: 201 + scoped upload URLs · valet-key
    loop each part
        C->>B: PUT part N
        B-->>C: ETag
        C->>V: PATCH /parts — number, ETag
        V->>M: mark part N landed
    end
    Note over C,M: connection drops — the client re-reads the row and sends only the unmarked parts
    C->>V: POST /complete
    V->>B: assemble the multipart upload
    V-->>C: 202 Accepted, state = Processing
```

### 2 · One file into a ladder of renditions → NFR: availability & resilience

**Make the unit of work one segment of one rendition and every hard property of the pipeline follows: it retries cheaply, it fans out without coordination, and no single failure costs more than a few seconds of video.** The alternatives are worth walking, because the cost of each shows up in a different place.

- **Naïve — one job per video.** A two-hour 1080p rung is hours of one core, a crash at 95% costs all of it, and jobs that long leave a fleet idle behind the longest one.
- **One job per rendition, checkpointed.** Halves the loss on a crash and keeps the tail: the slowest rendition still sets the publish time, and nothing parallelises inside a rendition. Rejected as a smaller version of the same shape.
- **Split first, then one job per segment (chosen).** Cutting at fixed segment boundaries, with a keyframe forced at each boundary in every rung, keeps the cut points aligned across rungs, and the resulting segments have no dependencies on each other, so the run becomes a [pipeline](../patterns/architecture/pipe-filter.md) whose expensive stage is [embarrassingly parallel](../patterns/messaging/competing-consumers.md) across as many workers as you will pay for.

Something has to know when the video is done, and it will not be the process that started it: hundreds of tasks fan out, the manifests wait on the last ack, and the whole thing spans hours across workers that restart. That is durable [workflow state](../patterns/distributed/coordination/workflow-orchestration.md) — the orchestrator holds the graph, survives its own crashes, and owns the retries and timers. A counter row each worker decrements works until the first lost or double ack, and from there you are writing a scheduler.

Workers pass references, not payloads. A segment's input and output both live in the blob store, so the queue message is a few hundred bytes of URLs — the [claim check](../patterns/messaging/claim-check.md) move; put the video in the message and the broker needs the bandwidth budget of the store. The [queue in front of the workers](../patterns/distributed/resilience/load-leveling.md) lets the fleet sit near the daily mean of ~14,000 cores rather than the peak hour's ~40,000, paid for in publish delay during a burst.

Queue shape decides who waits. One FIFO by arrival puts a twelve-hour upload's ten thousand segments in front of a ninety-second clip's twenty-three; separate queues by expected job count let the short ones through in minutes. Scale workers on queue depth and oldest-message age rather than CPU — a transcode fleet runs at 100% CPU by definition, so [autoscaling](../patterns/distributed/routing/autoscaling.md) on utilisation would never fire.

Redelivery causes both remaining problems. It is safe for an ordinary job because a segment's output key is computed rather than allocated: the retry recomputes the same bytes into the same `videoId/rendition/NNNN` object, overwriting its earlier attempt rather than leaving a second copy for the manifest to choose between. It is fatal for a job that never succeeds, because a file that crashes the encoder comes back and crashes again, forever. Bound the attempts and route the survivor to a [dead-letter channel](../patterns/messaging/dead-letter-channel.md), marking the video Failed with a reason the uploader can read.

```mermaid caption="Inside the Processing pipeline: how does one file become a ladder? Bounded per-segment jobs fan out, deterministic keys make redelivery safe, and the jobs that never succeed leave the loop instead of circling in it."
flowchart TB
    Blob[("Blob store · object-storage")] -->|"upload complete event"| Orch
    subgraph Pipeline["Processing pipeline"]
        direction TB
        Orch["Orchestrator · workflow-orchestration"] -->|"split on keyframes, no re-encode"| Split["Segmenter · pipe-filter"]
        Split -->|"one task per segment × rendition, URLs not bytes · claim-check"| Queue[["Transcode queue · load-leveling"]]
        Queue -->|"pull, bounded attempts"| Workers["Transcode workers ×N · competing-consumers"]
        Queue -->|"attempts exhausted"| DLQ[["Dead letters · dead-letter-channel"]]
        Workers -->|"last segment acked"| Man["Manifest builder"]
    end
    Workers -->|"PUT videoId/rendition/NNNN · idempotency"| Blob
    Man -->|"primary + media manifests"| Blob
    Man -->|"state = Playable"| Meta[("Metadata store")]
```

### 3 · Playback that starts fast and does not stall → NFR: latency

**Two seconds of startup and no stalls are bought in two places: distance to the viewer, and having a smaller rendition ready to switch to.** Neither is something the origin can optimise its way to.

Geography goes first because it is physics. A viewer 15,000&nbsp;km from the origin pays about 150&nbsp;ms per round trip in fibre, and a five-minute watch makes 76 of them — roughly 11&nbsp;s of waiting before any transfer. A long round trip also caps what one connection can pull, so a distant viewer cannot sustain the top rung on any local link. The answer's first tier is a copy of the segments near the viewer — a [CDN](../patterns/distributed/routing/cdn.md).

The ladder answers startup. A four-second 1080p segment at 5&nbsp;Mbit/s is 2.5&nbsp;MB, which takes four seconds to fetch on a 5&nbsp;Mbit/s link — the player would begin exactly at the edge of stalling. The same four seconds at 480p is 500&nbsp;KB and lands in under one. That is why a player starts low and steps up, and why the pipeline builds rungs nobody would choose to watch.

Switching rungs mid-watch is a pipeline property rather than a player feature. Every rendition is cut at the same boundaries with aligned keyframes, so segment 40 of the 480p rung starts at the same instant as segment 40 of the 1080p rung and the player can change its mind at any boundary without re-buffering. Cut each rendition independently, the boundaries drift, and switching becomes impossible. Segment duration is the dial: four seconds starts faster and reacts sooner, at ~800M new objects a day; ten seconds cuts that count by about 60% and leaves the player stuck on a bad rung for longer.

Caching is unusually easy here because a published segment never changes. Every tier runs on a long TTL with no invalidation protocol — the only question at each hop is whether the object is present, never whether it is right. The exception is the first minute of a viral clip, when every edge location misses the same objects at once: a [thundering herd](../hazards/thundering-herd.md) aimed at one prefix. Edge request collapsing bounds it to one origin fetch per object per location, and works because the objects are immutable.

The residual is that losing the edge has no graceful version. The origin is sized for ~5% of egress, so a full CDN failure is a 20× overload, and no origin headroom you would pay for closes that gap. The answer is a second edge vendor with DNS-level failover — a procurement decision rather than an engineering one, and worth naming as such instead of drawing a box for it.

```mermaid caption="What does one watch touch? One metadata read, then 76 edge fetches — the origin sees an object once per location, and the switch happens at a boundary the pipeline aligned."
sequenceDiagram
    autonumber
    participant P as Player
    participant V as Video Service
    participant E as CDN edge · cdn
    participant B as Blob store
    P->>V: GET /videos/{id}
    V-->>P: 200 state = Playable, manifest URL
    P->>E: GET primary manifest
    E-->>P: rendition list
    loop every ~4 s of playback
        P->>E: GET segment N at the chosen rung
        alt edge hit
            E-->>P: segment
        else edge miss
            E->>B: one fetch per object per location
            B-->>E: segment
            E-->>P: segment
        end
    end
    Note over P,E: bandwidth halves — the next request is for a lower rung, at the same boundary
```

### 4 · The one clip everybody watches → NFR: scale

**Metadata is trivially small and trivially fast right up to the moment popularity concentrates, and then two different things go wrong on the same row.** One is a read hot spot and the other is a write hot spot, and they need different answers.

VideoMetadata is [partitioned](../patterns/distributed/routing/sharding.md) by `videoId`: every access is an exact-key lookup, so hashing the id spreads 365M rows a year evenly and no query needs a scan. That is correct for the average and irrelevant to the outlier.

A clip taking 10M views in an hour is ~2,800 reads/s of one row. Partitioning cannot help — by construction that row lives on one set of replicas, which is the [hot partition](../hazards/hot-partition.md). [Consistent hashing](../patterns/distributed/routing/consistent-hashing.md) is the tempting wrong answer for the same reason: spreading keys evenly fixes an uneven catalogue, not one key everybody wants. Two things work and they stack — raise the replication factor for popular rows, and put a [shared cache](../patterns/caching/distributed-cache.md) in front keyed by `videoId`. The cache does nearly all the work; the [extra replicas](../patterns/distributed/coordination/replication.md) stop a miss landing on one node.

The write hot spot is the oddity, and it is the view counter. A hundred million views a day is ~1,200 increments/s under the same concentration. A durable read-modify-write per view puts every one of those on the row that is already the hottest thing in the system, so contention gets worse exactly when the product is winning — and it buys nothing anyone asked for, because no requirement needs a total correct to the second.

So count where the requests already are. Each Video Service instance keeps an in-memory tally per video and flushes an atomic add every few seconds — the [write-behind](../patterns/caching/write-behind.md) shape. A ten-second flush turns 1,200 increments/s into a handful of writes per hot video, and the total trails by at most one interval. State the bill: an instance that dies loses its unflushed window, and nobody can say which views those were. Where exactness matters — payouts, billing — the answer is the playback log the edge already writes, aggregated offline, which is the [ad-click aggregator](./ad-click-aggregator.md)'s design.

The residual is that cache and counter key on the same id, so the most popular video is the hottest entry in both and one cache node's network card is the next ceiling. Replicating that entry across cache nodes is the exit, deferred because the edge already absorbs the segment traffic — a key hot enough to saturate a cache node has to get past the CDN first.

```mermaid caption="One key, two problems: reads are absorbed in memory before the partition sees them, and writes are collapsed into one flush per interval instead of one per view."
flowchart TB
    Watch["~2,800 watches/s of ONE videoId"]:::ext --> V["Video Service ×N · stateless-service"]
    V -->|"read videoId"| K[("Metadata cache · distributed-cache")]
    K -->|"miss — one fill, then never again"| M[("Metadata store · sharding")]
    M -->|"raise the replication factor on hot rows · replication"| R[("Extra replicas of that partition")]
    V -->|"tally in memory, flush deltas every ~10 s · write-behind"| M
    classDef ext stroke-dasharray:4 4;
```

### 5 · What is worth keeping → NFR: durability

**Exactly one artifact here cannot be recreated, and treating everything else as equally precious is how the storage bill quietly becomes the largest line in the design.** Sort the bytes by whether you could make them again and the durability decisions answer themselves.

The master is irreplaceable: the uploader has moved on and asking for a re-upload is not a recovery procedure. It gets the strongest durability the store offers and a copy in a second region — the only cross-region replication here. Its access pattern then argues for tiering it down, because it is read exactly twice: once by the pipeline that builds the ladder, and again only if the ladder must be rebuilt.

Everything downstream is computed from the master. Losing a rendition costs ~2 core-seconds per video-second to rebuild — compute you schedule, for only the videos anyone wants. Replicating the ladder instead adds ~0.7&nbsp;GB per upload per region, about 250&nbsp;PB a year, billed every month whether or not a region is ever lost. So renditions live in one region with normal redundancy, and recovery means re-running the pipeline.

That asymmetry is what makes the exits in Right-sizing affordable: cold-tiering a master, building the top rungs on demand and re-encoding the cold catalogue all trade storage for compute, and they are only safe because the compute reproduces the bytes exactly. Price them before the catalogue is large — deleting a rendition you turn out to need costs the transcode again, and re-encoding a mature catalogue is a fleet-years job.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

**The biggest flaw, named first: a video is not watchable until a pipeline whose timing nobody controls has finished with it — publish latency is designed in, not an incident.** The uploader pays for everything the read path wins.

### Strengths
<!--meta polarity=pro-->

- **No application process ever holds a video byte.** ~95 Gbit/s inbound and ~520 Gbit/s outbound bypass the tier that serves the API.
- **The unit of work is one segment.** A crash costs a few seconds of video, and the expensive stage fans out with no coordination.
- **Everything downstream of the master is computed from it.** A lost rendition is a re-run, not a data loss, so only one artifact needs a second region.
- **Playback degrades instead of stopping.** A bandwidth drop moves the player down the ladder at the next segment boundary.
- Retried transcode jobs overwrite their own output, because a segment's key is computed rather than allocated.
- The read path never writes: one cached row read, then bytes from a rented edge.
- A new region is an edge and a cache — additive, with nothing to join and no consensus group to grow.

### Risks
<!--meta polarity=con-->

- **Publish latency is unbounded from the uploader's side.** A long video waits behind the fleet, and the API promises only a state field (see dive 2).
- **Losing the edge has no graceful version.** The origin is sized for ~5% of egress, so a CDN outage is a 20× overload rather than a degradation. At 99.9% playback availability (requirements-nfr-4) the budget is about 43 minutes a month, and a second edge starts with an empty cache, so the origin still takes a burst of misses at failover (see dive 3).
- **The client is a heavy participant.** Splitting, part bookkeeping, manifest parsing and rendition choice live in code you ship but do not run (see dive 1).
- **The storage bill compounds and the revenue does not.** ~1.7&nbsp;PB a day is never deleted, while income tracks only today's watches (named in Right-sizing).
- View totals trail by one flush interval and lose an instance's unflushed window when it dies (see dive 4).
- Abandoned multipart uploads are billable storage that appears in no listing of videos until a lifecycle rule aborts them (see dive 1).
- One crafted file can burn real fleet capacity in the window before the attempt limit dead-letters it (see dive 2).

## What's expected at each level
<!--meta block=levels-->

### Mid-level {#levels-h3-1}

- Asks how large one upload is and how many watches one upload earns, before drawing anything.
- Produces a working end-to-end flow — ask for a slot, upload parts, process, watch — with the bytes outside the application tier.
- Explains why one stored file cannot serve every device, and reaches for several renditions.
- Reaches for an edge cache when told the audience is worldwide, and can say what a miss costs.

### Senior {#levels-h3-2}

- Makes the unit of transcode work a segment, and says what that buys on retry and fan-out.
- Works out the resume mechanism from the tracked part list rather than reciting multipart upload.
- Separates the two piles — request rate against bytes moved — and sizes each on its own number.
- Treats a viral clip as its own failure mode rather than as a larger average.
- Names what happens to the job that never succeeds, when prompted, and bounds the attempts.

### Staff+ {#levels-h3-3}

- Prices a rendition ladder per hour of video before choosing how many rungs to build.
- Names the view counter as a write hot spot and trades exactness for an aggregated flush, unprompted.
- Separates what must be replicated from what can be rebuilt, and states what rebuilding costs.
- Prices the deferred exits — just-in-time packaging, hardware transcoding — against the triggers in Right-sizing.
- Defends designed-in publish latency as the design's biggest flaw, chosen deliberately.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Thundering Herd](../hazards/thundering-herd.md) — the first minute of a viral clip makes every edge location miss the same objects at once

**Demonstrates**

- [Valet Key](../patterns/distributed/routing/valet-key.md) — the Video Service hands the client a presigned URL so multi-gigabyte bytes upload straight to the blob store, never through the app tier
- [Object Storage](../patterns/distributed/routing/object-storage.md) — segments, renditions, and manifests all live in an S3-style blob store — the only tier that scales to a petabyte of new video a day
- [Pipe-and-Filter](../patterns/architecture/pipe-filter.md) — post-processing is a pipeline of split then transcode then manifest-generation, each a discrete transform over the previous stage's output
- [Workflow Orchestration](../patterns/distributed/coordination/workflow-orchestration.md) — a Temporal-style orchestrator builds the processing directed acyclic graph (DAG) and schedules worker nodes at the right time
- [Competing Consumers](../patterns/messaging/competing-consumers.md) — independent segments are transcoded in parallel by a fleet of interchangeable workers pulling from a queue
- [Cache-Aside](../patterns/caching/cache-aside.md) — a distributed cache keyed by videoId absorbs reads for popular videos so they never reach Cassandra
- [CDN](../patterns/distributed/routing/cdn.md) — segments and manifests are pushed to edge servers so streaming never travels back to the origin region
- [Replication](../patterns/distributed/coordination/replication.md) — hot video metadata is replicated onto extra Cassandra nodes so several can share a viral clip's read load
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the Video Service keeps no per-request state, so it scales out horizontally behind the load balancer
- [Idempotency](../patterns/messaging/idempotency.md) — The assembled-upload event is an idempotent trigger, so a retried notification cannot start the pipeline twice
- [Sweeper](../patterns/distributed/coordination/sweeper.md) — A sweep over rows stuck in Processing past a threshold closes the gap an unowned event source leaves
- [Claim Check](../patterns/messaging/claim-check.md) — Queue messages carry blob-store URLs, not video bytes — the broker never needs the store's bandwidth budget
- [Queue-Based Load Leveling](../patterns/distributed/resilience/load-leveling.md) — The queue in front of the workers lets the fleet run near the daily mean instead of the peak
- [Dead Letter Channel](../patterns/messaging/dead-letter-channel.md) — A file that crashes the encoder comes back forever; bounded attempts route it out, marking the video Failed with a reason
- [Sharding](../patterns/distributed/routing/sharding.md) — VideoMetadata partitions by video id so metadata scales independently of the blob tier
- [Distributed Cache](../patterns/caching/distributed-cache.md) — Popular rows get a shared cache in front of the metadata store, stacked with a higher replication factor
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — One entry point terminates transport layer security (TLS), authenticates uploaders and applies per-account limits
- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — Workers scale on queue depth and oldest-message age — a transcode fleet runs at 100% central processing unit (CPU) by definition, so utilisation never fires
- [Write-Behind](../patterns/caching/write-behind.md) — View counts tally in memory and flush an atomic add every few seconds, turning 1,200 increments into one write
- [Fan-In](../patterns/messaging/fan-in.md) — The workflow fans out to hundreds of video segments and fans in on the last one before publishing

<!-- relationships:end -->
