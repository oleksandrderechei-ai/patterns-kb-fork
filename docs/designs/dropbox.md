---
title: Dropbox
description: "Store, share, and sync files up to 50GB by moving bytes directly between client and blob storage — the app server signs URLs but never touches the data"
area: designs-intermediate
owner: Oleksandr Derechei
tags: [scalability, availability, durability, latency]
status: stable
aliases: [file sync, cloud storage, Google Drive]
solves: [users upload huge files but one request times out and my API gateway caps the body size, my users lose the whole upload when their connection drops halfway and have to start over from scratch, downloads are painfully slow for users far from my one data center, listing every file shared with a given user means scanning the permission list of every file I store, an edit made on a laptop should appear on the phone within seconds without anyone pressing refresh]
---

# Dropbox

A file storage service keeps a folder reachable from any device and identical on all of them. The scope is upload, download, share, and sync — but one constraint reshapes the whole design: files run as large as 50GB, so the bytes must never flow through the app server. The server signs URLs; the client talks to storage directly.

## Understanding the problem
<!--meta block=description-->

A cloud file service stores files, makes them reachable from any device, shares them with other users and keeps a folder in sync everywhere it is installed. Two decisions dominate the design. Files reach 50GB, so the bytes cannot pass through the app tier. And availability is chosen over consistency, because a few seconds of sync delay is harmless. The page walks through upload, download, sharing and sync.

## Explained
<!--meta block=explain-->

A file service for huge files keeps the bytes off your own servers: your server only checks permissions and signs a short-lived link, and the client sends or fetches the bytes directly from [blob storage](../patterns/distributed/routing/object-storage.md), which stores files as whole objects. The client cuts large files into 5 to 10 MB chunks, so a dropped connection resumes from the first missing chunk. Choose this over passing files through your servers whenever a file cannot cross one request, since a pass-through tier pays for every byte moved while a signing tier pays per chunk signed, not per byte moved. Favouring availability over consistency means a few seconds of sync lag is fine.

- **No inline scanning.** You cannot scan or convert a file as it passes. Start that work from storage's upload-complete notice.
- **Bearer links.** A signed link works for anyone who holds it, so expire it in minutes.
- **Untrusted client.** Before committing a file, ask storage which parts arrived instead of believing the client.
- **Lost edits.** Two devices can edit at once with no merge, so the later save wins. State that as a product decision.

**Example.** A 50 GB file over a 100 Mbps link needs 50 x 8,000 / 100 = 4,000 seconds, about 1.1 hours in one request, and a managed gateway rejects any body over 10 MB. Cut into 10 MB chunks that is 5,000 chunks, each with its own signed link. The connection drops after chunk 3,200: the client resumes at chunk 3,201, not byte zero. Before it marks the file uploaded, your server asks storage which of the 5,000 parts it holds, so a client that lied about its progress cannot commit a broken file.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Upload a file from any device.
2. Download a file from any device.
3. Share a file with other users, and see the files shared with you.
4. Automatically keep a folder in sync across all of a user's devices.

Out of scope: editing files and viewing them without downloading — named explicitly so the design stays narrow.

### Non-functional
<!--meta requirement=nfr-->

- **Availability** — favoured over consistency; a few seconds of sync lag is acceptable.
- **Large files** — support single files up to 50GB.
- **Durability** — secure and reliable; files recoverable if lost or corrupted.
- **Latency** — upload, download, and sync as fast as the network allows.

Out of scope: per-user storage quotas, file versioning, and virus scanning.

## Right-sizing
<!--meta block=sizing-->

**Transfer time.** A single 50GB upload over a 100&nbsp;Mbps link takes 50&nbsp;GB × 8 bits/byte ÷ 100&nbsp;Mbps ≈ **4,000&nbsp;seconds — about 1.1 hours**. Most gateways and proxies time out long before 1.1 hours, so one large `PUT` cannot work.

**Payload caps.** Managed front doors cap request bodies hard — Amazon API Gateway at 10&nbsp;MB, not raisable. A 50GB body cannot cross that boundary even in principle, which forces the file to be broken into pieces.

**Chunk count.** At 5–10&nbsp;MB per chunk, a 50GB file is roughly **5,000–10,000 chunks**, each independently retryable and sent straight to storage, so the gateway cap never applies to them. At 5&nbsp;MB a 50GB file is 10,000 parts, exactly the S3 multipart limit of 10,000 parts, so pick the chunk size by file size.

**What the backend actually carries.** Because the bytes travel client-to-storage directly, the app tier only handles metadata operations — small and frequent. The service sizes on control-plane calls, not on terabytes of file traffic, which is what makes 50GB files affordable at all.

## Core entities
<!--meta block=entities-->

Four entities, split cleanly between where bytes live and where facts about them live:

- **File** — the raw bytes. Lives in blob storage, never in the database.
- **FileMetadata** — `id` (a UUID (universally unique identifier)), `name`, `size`, `mimeType`, `uploadedBy`, and a `status` of `uploading` or `uploaded`. For resumable uploads it also carries per-chunk status, and a content `fingerprint` for deduplication.
- **User** — the account that owns and shares files.
- **SharedFile** — a `(userId, fileId)` row recording that a file is shared with a user. It is a separate table, deliberately not a list embedded on the file.

## The interface
<!--meta block=interface-->

One endpoint per requirement — and, crucially, the upload and download endpoints return a URL to talk to storage rather than accepting or returning the bytes themselves. Identity always rides in the headers as a session token or JWT (JSON Web Token), never in the body, which the client can tamper with.

```http summary="HTTP — the request surface"
POST /files/presigned-url        { fileMetadata } → { presignedUrl }
  # backend saves metadata with status "uploading", returns a signed write URL

PUT  <presignedUrl>              <bytes>            # client → blob storage, direct

GET  /files/{fileId}/presigned-url → { presignedUrl }   # CDN-signed read URL

POST /files/{fileId}/share       { users: [ ... ] }

GET  /files/changes?since={ts}   → ChangeEvent[]   # poll fallback for sync
  # ChangeEvent = { fileId, type: created|updated|deleted, metadata }

PATCH /files/{fileId}/chunks     { chunks: [ { id, status, eTag } ] }
```

## How the system is built
<!--meta block=architecture-->

The organising idea is that the app server is a **control plane, not a data plane**. A **File Service** sits behind a [load balancer](../patterns/distributed/routing/load-balancer.md) and [API gateway](../patterns/distributed/routing/api-gateway.md) — which does routing, Transport Layer Security (TLS) termination, rate limiting, and request validation — and its only jobs are to read and write metadata, enforce share permissions, and hand the client a presigned URL: a signed, time-limited grant to write to (or read from) one exact [blob-storage](../patterns/distributed/routing/object-storage.md) location. That URL is a textbook [valet key](../patterns/distributed/routing/valet-key.md) — the service generates it locally with the storage SDK using its own credentials, so signing costs nothing and never calls storage. The client then `PUT`s the bytes **straight to blob storage**. When the upload lands, storage fires a completion notification back to the File Service, which flips the metadata to `uploaded` — the handshake that keeps "bytes present" and "metadata says present" from drifting apart. Because it holds no per-request state, the File Service is a [stateless service](../patterns/distributed/routing/stateless-service.md) that scales out horizontally.

Downloads are the mirror image, but through a [CDN](../patterns/distributed/routing/cdn.md): the File Service issues a CDN (content delivery network)-signed URL, the edge serves the file from the cache nearest the user, and only a cache miss reaches origin storage — the fix for a single-region blob store being slow for distant users. **Sharing** is the separate `SharedFiles` table keyed on `(userId, fileId)`: "my files" is an index scan on `uploadedBy`, and "files shared with me" is an index scan on the shares table — neither one has to scan every file's permission list, which is exactly what an embedded share-list would force. **Sync** runs a hybrid: one persistent WebSocket/SSE connection per device carries change events the server [publishes](../patterns/messaging/pubsub.md) in real time, backed by a periodic poll of `/files/changes?since=` so a dropped socket still converges — [eventual consistency](../themes/consistency-and-replication.md) by construction. Local edits are caught by the OS file-watcher (`FSEvents`, `FileSystemWatcher`), queued, and pushed; conflicts resolve last-write-wins.

**Durability** is bought rather than built. Managed blob storage keeps every object redundantly across independent failure domains and verifies it against a stored checksum, so a lost or corrupted copy is rebuilt from the surviving ones without the File Service knowing it happened; the metadata database earns the same guarantee from its own replicas. That covers the half of the NFR (non-functional requirement) that infrastructure can cover. It does not cover a user overwriting their own file with something worse — file versioning answers that, and versioning is out of scope here, so "recoverable" on this page means recoverable from storage loss, not from a bad edit.

```mermaid caption="The File Service signs URLs and moves metadata; the file bytes flow client→storage and storage→edge→client, never through the app tier."
flowchart TB
    Client["Client — uploader & downloader"]
    GW["LB & API gateway"]
    FS["File service (control plane)"]
    DB[("File metadata DB")]
    S3[("Blob storage")]
    CDN["CDN edge"]
    Client -->|"request presigned URL"| GW
    GW -->|"route, authenticate"| FS
    FS -->|"read / write metadata + shares"| DB
    FS -.->|"signed URL"| Client
    Client -->|"PUT chunks directly"| S3
    S3 -.->|"upload-complete notification"| FS
    Client -->|"GET file"| CDN
    CDN -->|"cache miss"| S3
    FS -.->|"push change events"| Client
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Uploading a 50GB file

A single request is impossible (the 1.1-hour and 10&nbsp;MB limits above), and even if it weren't, it would give no progress and no way to resume. The answer is **chunking on the client** — 5–10&nbsp;MB pieces. Chunking must happen client-side: doing it on the server would require the whole file to reach the server first, which is the very thing we are avoiding, and it is a common candidate mistake to get this backwards.

- **Multipart mechanics.** The client asks the backend to begin an upload; the backend calls storage's `CreateMultipartUpload`, gets an `uploadId`, and returns one presigned URL per chunk (keyed by `uploadId` + `partNumber`). Chunks then upload in parallel or in sequence to their own URLs. Unfinished multipart uploads keep their stored parts and keep costing until aborted, so set a bucket lifecycle rule that aborts incomplete multipart uploads after a set number of days.
- **Progress and resume.** Progress is simply the fraction of chunks finished. Resumability comes from persisting each chunk's status in `FileMetadata.chunks`, so a dropped connection resumes from the first unfinished chunk rather than byte zero. Presigned part URLs issued at the start can expire before a long transfer ends, so a resume asks the backend for new URLs for the unfinished parts only.
- **Verify before commit.** The client `PATCH`es chunk status to drive a progress bar. A buggy or malicious client could claim unfinished chunks are done, so before flipping the file to `uploaded` the backend checks storage with `ListParts` and ETags, then calls `CompleteMultipartUpload` once every part checks out. Retries are safe because a re-reported or re-uploaded chunk is a no-op ([idempotency](../patterns/messaging/idempotency.md)).
- **Identity by content, not name.** Filenames collide across users and uploads; a SHA-256 fingerprint of the content does not. The fingerprint drives deduplication (identical content already stored need not be re-uploaded) and resume detection (which parts already exist), while the UUID `fileId` stays the row's unique key. Cross-user dedup leaks existence: skipping an upload because the hash is already stored tells a client that some user holds that file, so scope dedup to one user's own files or require proof that the client holds the bytes.

### 2 · Making uploads, downloads, and sync fast

Three levers, one per direction.

- **Download** — the CDN already shortens the distance bytes travel by serving from the edge; nothing else moves the origin closer.
- **Upload** — chunks uploaded in parallel saturate available bandwidth, and chunk size can adapt to current network conditions.
- **Sync** — transfer only the chunks that changed, not the whole file. Fixed-size chunking sabotages this: inserting one byte near the start shifts every later boundary and changes every downstream fingerprint. **Content-Defined Chunking** — boundaries chosen by a rolling hash (Rabin fingerprinting) — means a small edit perturbs only the chunks near it, keeping delta sync cheap.

**Compression** happens on the client, since the backend is off the data path — compress before upload, decompress after download. It pays for text (a 5GB log can drop below 1GB) but barely helps already-compressed media (a PNG hardly moves), so the client decides by file type, size, and network. `zstd` is a strong client-side default; Brotli edges it on text. One firm rule: always compress before encrypting, because ciphertext is effectively random and will not compress.

### 3 · Keeping files secure

Encryption is the easy half: HTTPS in transit, and storage-side encryption at rest with a per-object key held separately from the data. Access control is the shares table acting as the ACL (access control list) — a download URL is only issued to an authorized user. The subtle risk is the **signed URL itself**: it is a bearer token, so anyone holding a valid, unexpired one can use it, and an authorized user might leak it. The defense is a short expiry (around five minutes) so a leaked link dies quickly; higher-security setups additionally bind the URL to an IP or require it alongside an auth cookie. This is [least privilege](../patterns/security/least-privilege.md) applied to a URL — the narrowest grant, for the shortest time. The CDN or storage validates the signature against its registered public key and checks expiry and any restriction before serving a byte.

```mermaid caption="How does a 50 GB upload resume after a dropped connection and survive a lying client? Bytes go straight to storage; the backend commits only after verifying the parts itself."
sequenceDiagram
    autonumber
    participant C as Client
    participant B as File Service
    participant S as Object storage
    C->>B: begin upload, content fingerprint
    B->>S: CreateMultipartUpload
    S-->>B: uploadId
    B-->>C: one presigned URL per chunk
    loop each 5-10 MB chunk
        C->>S: PUT chunk to its own URL
        C->>B: PATCH chunk status
    end
    C->>B: request complete
    B->>S: ListParts, check ETags
    alt every part present
        B->>S: CompleteMultipartUpload
        B-->>C: file marked uploaded
    else client over-reported or part missing
        B--xC: reject, resume from first missing chunk
    end
```

The download path is where the signed URL is issued and then checked.

```mermaid caption="How does a download get authorized, and what stops a leaked signed URL from living long?"
sequenceDiagram
    autonumber
    participant C as Client
    participant FS as File Service
    participant CDN as CDN
    C->>FS: request download
    FS->>FS: check shares table (ACL)
    FS-->>C: signed URL, expires in about five minutes
    C->>CDN: GET signed URL
    CDN->>CDN: validate signature, expiry, any restriction
    CDN-->>C: file bytes
```

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- The app tier never touches file bytes, so backend cost scales with chunk count (about 5,000 signed URLs and status updates for a 50GB file at 10 MB chunks), not with bytes moved, and upload and download scale with storage and the edge rather than with the servers.
- Chunking delivers resumable, parallel, progress-tracked uploads. Delta sync that moves only what changed is cheap only with content-defined chunking, because fixed-size chunks shift every boundary after an insert.
- Direct-to-blob writes plus CDN reads keep latency low for users anywhere in the world.

### What it gives up
<!--meta polarity=con-->

- With bytes bypassing the server, it cannot inspect or transform them in flight — no server-side virus scanning, transcoding, or content validation without adding a separate pipeline.
- Signed URLs are bearer tokens; a short expiry limits but never eliminates the exposure of a leaked link.
- Choosing availability means a change can be visible on one device before another, and last-write-wins silently drops the losing edit of a genuine conflict.
- Server-side chunk verification (`ListParts`) adds round trips and moving parts over simply trusting the client's progress reports.

## What's expected at each level
<!--meta block=levels-->

- **Mid-level** — a working end-to-end design: clear endpoints and a metadata model, upload/download/share/sync sketched at a high level, and blob storage for the files. Not expected to reach presigned URLs or chunking unprompted, but should get there when nudged — "you're uploading the file twice, how do you avoid that?" or "how do you show progress and let the user resume?"
- **Senior** — moves quickly through the high-level design to spend real time on large-file handling; argues the blob-storage and CDN trade-offs from experience, often knows the multipart-upload API first-hand, and anticipates bottlenecks instead of only reacting to them.
- **Staff+** — races through the basics (representational state transfer (REST), normalization) to go deep on the interesting parts: delta sync and content-defined chunking, trust-but-verify integrity, signed-URL security, and the availability-over-consistency posture — driving the discussion and treating the interviewer as a peer.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Valet Key](../patterns/distributed/routing/valet-key.md) — the File Service hands the client a presigned URL — a signed, time-limited grant to write to or read from one exact blob location
- [Object Storage](../patterns/distributed/routing/object-storage.md) — file bytes live in an S3-style blob store, not on the app servers or in the metadata database
- [CDN](../patterns/distributed/routing/cdn.md) — downloads are served from the edge cache nearest the user, with only a miss reaching origin blob storage
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — an load balancer (LB) and application programming interface (API) gateway front the File Service, handling routing, transport layer security (TLS) termination, rate limiting, and request validation
- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — the File Service signs URLs locally and holds no per-request state, so it scales out horizontally behind the load balancer
- [Publish-Subscribe](../patterns/messaging/pubsub.md) — the server publishes file change events over a persistent per-device connection so edits propagate to other devices in real time
- [Idempotency](../patterns/messaging/idempotency.md) — resumable chunked uploads rely on re-reported or re-uploaded chunks being safe no-ops, with a content fingerprint deduplicating identical uploads
- [Least Privilege](../patterns/security/least-privilege.md) — signed URLs are scoped to one object and expire in minutes, optionally bound to an Internet Protocol (IP) or auth cookie, granting the narrowest access for the shortest time
- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — The File Service sits behind a load balancer and gateway so metadata calls spread across stateless instances

<!-- relationships:end -->
