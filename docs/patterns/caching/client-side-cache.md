---
title: Client-Side Cache
description: "Cache on the user's own device, so repeat requests never leave it"
area: caching
owner: Oleksandr Derechei
tags: [caching, latency, edge]
status: stable
aliases: [browser cache, HTTP cache, on-device cache]
solves: [users re-download the same images and data on every page load, my app needs to keep working offline and sync when it reconnects, the network round trip is the bottleneck even with a CDN, navigating back to a page someone already visited reloads everything from scratch, people on metered mobile connections burn their data downloading the same files again]
---

# Client-Side Cache

Stores data directly on the user's device — the browser's HTTP cache, local storage, or an app's on-device store — so a repeated read is answered without any network request at all.

## What it is
<!--meta block=description-->

Every other cache still sits across a network from the user, even a CDN edge milliseconds away. A client-side cache stores data on the user's own device, in the browser's HTTP cache, localStorage or an app's local store. A repeat read makes no network request at all, which also takes that load off the origin.

## Explained
<!--meta block=explain-->

A client-side cache keeps responses on the user's own device, in the browser's HTTP cache, localStorage or an app's local store, so a repeat read makes no network request at all. Choose it over a [CDN](../distributed/routing/cdn.md) (servers near the user that hold copies) when the round trip is the cost, as with static files or an app that must work offline, because it relieves the edge and your servers together. You give up control: once data lives on the device you have the least say over when it refreshes, so it suits static assets and offline work, and least suits data that must always be fresh.

- **No recall.** A long lifetime on a URL whose content later changes strands users on the old copy; put a content hash in the filename.
- **Every device warms alone.** Each new visitor downloads everything once, so keep first-visit files small.
- **Storage can vanish.** Treat it as a copy, never the record, and clear private data on logout.

**Example.** Your app serves main.js at 400 KB and sees 10,000 visits a day, 2,000 of them from new devices. With a one-year lifetime and the file name main.3f9a.js, the 8,000 returning visits download nothing, so the day moves 800 MB instead of 4 GB. You ship a fix and the file becomes main.7c21.js. Each returning device fetches it once, provided the HTML page that names it is short-lived or revalidated; otherwise devices never learn the new name. Had the file stayed /main.js with the same one-year lifetime, those 8,000 devices would keep running the broken copy for up to a year, with no way to recall it.

## How it works
<!--meta block=structure-->

```mermaid caption="What can the server still change once the bytes are on the device? Only what it said at step 1 — inside the lifetime no request is made at all, and the earliest chance to correct a value is the conditional request at step 3, which is why a bad long lifetime is fixed by changing the URL rather than by recalling the entry."
flowchart LR
    App["App code on the device"]
    subgraph Dev["On the device — the server's only lever is the header it already sent"]
        Store[("Local store: bytes + max-age + ETag")]
    end
    Edge["CDN edge"]:::ext
    Origin["Origin"]:::ext
    App -->|"1 read: still inside max-age?"| Store
    Store -->|"2 yes, serve locally, nothing leaves the device"| App
    Store -->|"3 expired: conditional GET with the ETag"| Edge
    Edge -->|"4 forwards on a miss"| Origin
    Origin -->|"5 304 Not Modified, or fresh bytes and a new lifetime"| Store
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **HTTP caching** — The browser caches responses automatically based on headers the server sends — `Cache-Control` / `max-age` for freshness, `ETag` / `Last-Modified` for cheap revalidation — with no application code at all.
- **Web storage / IndexedDB** — The app explicitly stashes data in `localStorage`, `sessionStorage`, or IndexedDB, giving it full control over what's kept and when it's cleared — useful for API responses and app state.
- **Service-worker offline cache** — A service worker intercepts requests and serves cached responses, enabling true offline use and fine-grained cache strategies (cache-first, network-first, stale-while-revalidate).
- **Native on-device store with sync** — A mobile app keeps data in memory or on local disk and syncs with the server when connectivity returns — the offline-first shape behind apps that keep working on a train.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The fastest read a client can get**: served from the device with no network request, though disk or worker startup still cost some time.
- **Offloads the origin** and the network for anything the client already holds.
- **Enables offline use** — the app keeps working when connectivity drops. Syncing writes back later is a separate variation: a native on-device store with sync.
- **For static assets**, HTTP caching gets much of this for free, driven only by response headers.

### Cons
<!--meta polarity=con-->

- **The least control over freshness**: once data is on the device, invalidating it is hard and it readily goes stale.
- **Per-device only** — nothing is shared between users, and every client warms its own cache.
- **Storage is limited** and can be evicted or cleared by the browser or OS at any time.
- **A security surface**: sensitive data cached on a device can be read by anyone with access to it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Static assets** — images, scripts, styles — can be reused across page loads instead of re-downloaded.
- **The workload is offline-capable or client-heavy**, and the app must work without a live connection.
- **Non-sensitive per-user data rarely changes** and the network round trip is the dominant cost, even with a CDN.

### Avoid when
<!--meta polarity=avoid-->

- **The data must always** be fresh or consistent across users — the freshness window is hardest to control here.
- **The data is sensitive** and shouldn't rest on a device you don't control.
- **The server must authorize or observe every read**, which a device-served cache bypasses.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a browser-side cache in localStorage with a short TTL"
// Cache on the device itself: a repeated read never leaves the browser.
// You control freshness with a TTL, since the client won't be told to refresh.
function readCached<V>(key: string): V | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  let entry;
  try { entry = JSON.parse(raw); } catch { localStorage.removeItem(key); return null; }  // corrupt entry: treat as a miss
  const { value, expiresAt } = entry;
  if (Date.now() > expiresAt) { localStorage.removeItem(key); return null; }  // stale → drop
  return value as V;
}

function writeCached<V>(key: string, value: V, ttlMs: number): void {
  try { localStorage.setItem(key, JSON.stringify({ value, expiresAt: Date.now() + ttlMs })); }
  catch { /* quota or eviction: treat as a miss, do not cache */ }
}

```

## In the wild
<!--meta block=wild-->

- **HTTP caching (Cache-Control, ETag)** — Browsers cache responses per the server's Cache-Control and revalidate with ETag/Last-Modified. {#wild-http-cache}
- **Service Worker Cache API** — Lets a web app intercept requests and serve cached responses, including fully offline. {#wild-service-worker}
- **Web Storage / IndexedDB** — localStorage and IndexedDB let an app persist data on the device under its own control. {#wild-web-storage}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Cache-Control lifetime** — How long a response may be reused without asking the server again; s-maxage is ignored by a device's own cache and sets the lifetime for shared caches such as the CDN, and no-store keeps a response off the device entirely
- **Validators for revalidation** — Whether responses carry an ETag or Last-Modified, so a client can re-check a stale entry with a conditional request and get 304 Not Modified instead of the whole body
- **Content-hashed asset URLs** — Filenames that change whenever the bytes change, so long-lived assets can be cached hard and busted by URL rather than by waiting for expiry
- **Per-route caching strategy** — Which policy a request follows in a Service Worker — cache-first, network-first or stale-while-revalidate — and what is served when the network is unavailable
- **Device store and storage budget** — Which store holds the data (in-memory, Web Storage, IndexedDB, the Cache API) and how much of the browser or OS storage allowance the app is willing to occupy

### Signals to watch
<!--meta polarity=signal-->

- **Share of reads served from the device** — Requests answered locally with no network at all, measured in the client (for example real-user timing where no bytes were transferred) because servers never see these hits; the number that says whether the cache is doing anything
- **Ratio of 304 to 200 responses** — How many conditional requests come back Not Modified; mostly full 200s means validators are missing or not being honoured
- **Bytes transferred on a repeat visit** — Network bytes on a second visit compared with a first; if it barely falls, nothing is being reused
- **Storage used against the quota** — How close the app sits to its storage allowance, since crossing it triggers eviction of exactly the data offline mode depends on
- **Age of the entries being served** — How old locally-served values actually are, which is the staleness users experience

### Failure modes under load
<!--meta polarity=failure-->

- **Stale bytes pinned on returning devices** — A long lifetime on a URL whose content changed leaves devices serving the old copy until it expires — there is no way to recall it
- **Eviction under storage pressure** — The browser or OS reclaims space and clears the store, so an offline-capable app loses its data without warning
- **Deploy skew between shell and API** — A device still holds an old application bundle while the server has moved on, so cached client code calls an interface that has changed
- **Every new device pays the full cost** — Nothing is cached before a first visit, so the origin absorbs the entire payload for each new device and each cleared one
- **Private data outliving the session** — Cached responses persist after logout unless explicitly cleared, leaving them readable by the next person to use the device

### Readiness checklist
<!--meta polarity=check-->

- Set an explicit Cache-Control on every response — silence leaves the lifetime to heuristics you do not control
- Version immutable assets by content hash so a deploy busts them by URL instead of waiting on expiry
- Send a validator (ETag or Last-Modified) on anything cacheable, so a stale entry can be re-checked without re-downloading it
- Mark responses carrying personal or authorization-dependent data no-store, and clear device storage on logout
- Handle the quota-exceeded and eviction paths explicitly — treat device storage as a cache that can vanish, never as the record
- Test the second visit and the offline path, not just the first load; a cold-only test never exercises the cache
- Keep a way to force a client past a bad cached entry, such as a versioned URL or a kill switch the app checks on start

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Caching](../../themes/caching.md) — Placement on the user's device {#fluency-caching}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [CDN](../distributed/routing/cdn.md) — The device checks its own cache before even the edge

**Often confused with**

- [In-Process Cache](./in-process-cache.md) — Both keep a copy next to the reader; this one lives on the user's device, so a hit never reaches your servers

**Prevents**

- [No Caching](../../hazards/no-caching.md) — Stops a repeated read at the client, so it never reaches the source at all

**Exposed to**

- [Stale Cache](../../hazards/stale-cache.md) — Can fall into stale cache when copies on devices cannot be invalidated centrally

**Demonstrated by**

- [Tinder](../../designs/tinder.md) — a client-side cache absorbs the read-your-own-writes gap without a server-side cache to maintain
- [Strava](../../designs/strava.md) — the phone is a client-side cache that is the source of truth for the workout until sync

<!-- relationships:end -->
