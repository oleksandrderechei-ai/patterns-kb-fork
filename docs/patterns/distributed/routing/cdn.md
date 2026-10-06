---
title: CDN
description: "Caches and serves static content from the edge, near the user"
area: distributed-scale
owner: Oleksandr Derechei
tags: [caching, latency, edge]
status: stable
aliases: [content delivery network, content distribution network]
solves: [users on the other side of the world say the site takes eight seconds to load, our origin falls over every time a post hits the front page, we serve the exact same logo image a million times from one machine, the bandwidth bill is enormous and it is all the same unchanging files, the app feels instant in our office and sluggish everywhere else]
---

# CDN

Pushes static content out to a distributed fleet of edge servers positioned near users, so a request is answered from a nearby cache instead of crossing continents to a single origin.

## What it is
<!--meta block=description-->

A **content delivery network** is a set of cache servers in many regions between users and your origin server. Round-trip time is bounded by distance, and one origin takes every spike, crawler and hotlink. Each request goes to the nearest cache, which answers from a fresh copy without touching the origin, so the origin sees only first requests, misses and refreshes after a copy expires.

## Explained
<!--meta block=explain-->

A CDN (content delivery network) is a set of cache servers in many regions that answer requests for your files from a place near the user, so most requests never travel to your own server, called the origin. Each user is sent to the nearest cache, by DNS or anycast routing. If it holds a fresh copy it answers at once, and if not it fetches from the origin once and keeps the copy. Without it, a user across the globe pays the speed-of-light round trip on every request, and every spike lands on one origin. Choose it over a bigger origin when many users want the same content, because distance sets the limit and a faster origin cannot shorten it.

- **Stale copies.** Copies stay until their time to live (TTL) ends, so use short TTLs for changing files and versioned names for the rest.
- **Personal content.** It barely caches, so serve it from the origin and cache only the shared parts.
- **Origin misses.** First requests and misses still reach the origin, so size it for those.
- **Another layer.** It is one more vendor to debug, so log cache hits and misses.

**Example.** Your origin is in Frankfurt and a user in Sydney is about 300 ms away. Fetching a product image takes 3 round trips, setup plus the request, so about 900 ms. From a Sydney cache 20 ms away it takes 60 ms. At 1,000 requests a second with a 95% hit rate, the origin sees 50 a second, not 1,000. The cost shows when you replace the logo: caches keep the old one for up to the 1 hour TTL, so you publish it as logo.v2.png, a new name that is a new cache entry.

## How it works
<!--meta block=structure-->

```mermaid caption="How does everyone after the first user avoid the trip to the origin? Step 3 pays the distance once; steps 4 to 7 serve every later request from a machine milliseconds away, and the origin hears nothing until the copy expires or is purged."
flowchart LR
    User["First user"]
    DNS["DNS / anycast routing"]
    subgraph PoP["Nearest point of presence"]
        Edge["Edge server"]
        Store[("Cached copy, held for its TTL")]
    end
    Origin["Origin server"]:::ext
    Later["Later users nearby"]
    User -->|"1 resolve the host"| DNS
    DNS -->|"2 route to the nearest PoP"| Edge
    Edge -->|"3 fetch the object once"| Origin
    Edge -->|"4 store it for its TTL"| Store
    Edge -->|"5 serve the bytes"| User
    Later -->|"6 ask for the same object"| Edge
    Store -->|"7 answer locally, origin untouched"| Later
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **[Cache-Aside](../../caching/cache-aside.md) pull model** — The default: an edge node checks its own cache and, on a miss, fetches from origin and stores the result, so origin traffic follows cold paths plus refreshes after TTL expiry or purge.
- **Push CDN** — The origin proactively uploads or replicates content to edges ahead of demand, instead of waiting for a first request. Common for large media libraries with a known release schedule.
- **[Consistent Hashing](./consistent-hashing.md) for edge selection** — Within a PoP or across a shard, requests for the same key route to the same cache node by hash, so duplicate copies of one object don't scatter across the fleet.
- **Multi-CDN** — Route across two or more CDN vendors, by region or health, to avoid a single provider's outage or peering problem taking down delivery entirely.
- **Edge compute** — Run request-time logic — auth checks, redirects, A/B routing, image transforms — at the PoP itself, so even dynamic decisions skip the trip to origin.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Cuts latency** by answering from a PoP physically close to the user, not the origin.
- **Absorbs traffic spikes** and bandwidth cost at the edge, shielding the origin, provided the hit ratio stays high; a poor cache key sends spikes straight to origin.
- **Keeps serving through a short origin outage** — cached content keeps serving until its TTL expires, or longer if the edge is set to serve stale.
- **Scales to a global audience** without provisioning the origin for worldwide peak load.

### Cons
<!--meta polarity=con-->

- **Cache invalidation is the hard part** — stale content lingers until TTL expiry or a purge propagates everywhere.
- **Personalized, highly dynamic, or per-user content** doesn't cache well and gains little.
- **Another layer of infrastructure**, config, and vendor to operate and debug.
- **Doesn't remove the origin dependency** — cold paths and misses still hit it directly.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You serve static assets** — images, scripts, video, downloads — to a geographically spread audience.
- **Traffic is spiky or global**, and the origin shouldn't have to absorb it directly.
- **Latency to a distant origin** region is the bottleneck users actually feel.

### Avoid when
<!--meta polarity=avoid-->

- **Content is deeply personalized per** request with no cacheable overlap between users.
- **Your whole audience is co-located with the origin** — there's no distance to remove.
- **Reads must be strictly consistent** and a stale cached response is unacceptable.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a minimal pull-mode edge cache"
interface Origin {
  fetch(path: string): Promise<{ body: string; ttlSeconds: number }>;
}

interface CacheEntry {
  body: string;
  expiresAt: number;
}

class EdgeNode {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<string>>();

  constructor(private readonly origin: Origin) {}

  async serve(path: string): Promise<string> {
    const hit = this.cache.get(path);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.body; // cache hit — no origin request
    }
    const pending = this.inflight.get(path);
    if (pending) return pending; // concurrent misses share one origin fetch
    const fetching = this.origin.fetch(path).then(({ body, ttlSeconds }) => {
      this.cache.set(path, { body, expiresAt: Date.now() + ttlSeconds * 1000 });
      return body;
    }).finally(() => this.inflight.delete(path));
    this.inflight.set(path, fetching);
    return fetching; // cache miss
  }

  purge(path: string): void {
    this.cache.delete(path); // explicit invalidation ahead of TTL
  }
}
```

## In the wild
<!--meta block=wild-->

- **Akamai** — One of the first CDNs, grown out of MIT research on consistent hashing for web caching; its distributed edge fleet serves cached objects from PoPs close to users and pulls from origin only on cold paths. {#wild-akamai}
- **Cloudflare** — Uses anycast to route each request to the nearest of its many PoPs; edges serve cached assets and can run request-time logic in the Workers runtime, and tiered caching funnels misses through upper-tier data centers to cut origin load. {#wild-cloudflare}
- **Fastly** — Built on Varnish; its instant-purge system can invalidate cached objects across the whole network in seconds, and VCL and its Compute platform let request logic run at the edge. {#wild-fastly}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Cache TTL / max-age** — How long an edge serves an object before revalidating with origin, set via Cache-Control or an edge override per asset class. Use long TTLs for fingerprinted assets and short TTLs or revalidation for HTML; work out each from how often the content changes and how fast a purge reaches every edge.
- **Cache key composition** — Which parts of the request — path, selected query params, headers, cookies — vary the cached object; over-broad keys destroy the hit ratio.
- **Origin timeout and failover** — How long the edge waits on origin and whether it fails over to a backup origin or serves stale content.
- **Tiered caching / origin shield** — Whether misses funnel through a mid-tier before hitting origin, so origin sees far fewer requests.
- **Purge and invalidation strategy** — TTL expiry versus explicit purge for pushing new content out ahead of TTL.

### Signals to watch
<!--meta polarity=signal-->

- **Cache hit ratio** — The fraction of requests served from the edge — the primary health metric for offload.
- **Origin request rate and egress** — What actually reaches origin after edge offload, and the bandwidth it costs.
- **Edge latency and error rate** — p99 and error rate split by edge-served versus origin-served responses.
- **Bandwidth served from edge** — Bytes delivered at the edge versus fetched from origin.

### Failure modes under load
<!--meta polarity=failure-->

- **Hit-ratio collapse** — The cache key varies on a cookie or volatile query param, so nearly everything misses and origin is flooded.
- **Stale content after deploy** — TTL too long or a purge that did not propagate leaves old assets served from some PoPs.
- **Cache stampede** — Many edges miss the same key at once when it expires and hit origin simultaneously; needs request coalescing or a shield.
- **Origin outage past TTL** — Once cached copies expire the edge has nothing to serve, and errors surface to users; serve stale on origin error, with a grace window longer than the expected outage.

### Readiness checklist
<!--meta polarity=check-->

- Cache key normalized — irrelevant query params and cookies stripped to maximize hits.
- Cache-Control and TTLs set per asset class; static assets fingerprinted in the URL for safe cache-busting.
- Purge and invalidation path tested and fast enough for the content's change rate.
- Origin protected by request coalescing or a shield tier so a miss storm cannot overwhelm it.
- Hit ratio and origin offload monitored with alerts.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [System Design Interview](../../../themes/system-design-interview.md) — Serve content from the edge, near the user {#fluency-system-design-interview}
- [Handling Spikes](../../../themes/spike-handling.md) — Serve the static surge from the edge {#fluency-spike-handling}
- [Performance](../../../themes/performance.md) — Cut latency by serving from the edge {#fluency-performance}
- [Scaling Reads](../../../themes/scaling-reads.md) — Cache read-heavy responses at the edge, near users {#fluency-scaling-reads}
- [Caching](../../../themes/caching.md) — Cache at the network edge, near the user {#fluency-caching}
- [Global Traffic & Ingress](../../../themes/global-traffic-and-ingress.md) — Answer at the edge so no region is touched at all {#fluency-global-traffic-and-ingress}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Consistent Hashing](./consistent-hashing.md) — Edge nodes are chosen by hashing
- [Cache-Aside](../../caching/cache-aside.md) — The edge caches; origin fills on a miss
- [Client-Side Cache](../../caching/client-side-cache.md) — The edge tier behind the client's own cache
- [Object Storage](./object-storage.md) — Caches and serves objects that live in an object store, close to the user.
- [Reverse Proxy](./reverse-proxy.md) — Each edge node is a caching reverse proxy near the user
- [Storage](../../../capabilities/storage.md) — The origin behind most content delivery networks (CDNs) is a bucket, not an application server.
- [API Routing](./api-routing.md) — Edge functions can run API routing rules at the edge

**Prevents**

- [No Caching](../../../hazards/no-caching.md) — Absorbs repeat reads of the same content before they reach the origin

**Exposed to**

- [Stale Cache](../../../hazards/stale-cache.md) — Can fall into stale cache when edge copies outlive the origin's change until expiry or purge

**Demonstrated by**

- [Bitly](../../../designs/bitly.md) — Bitly serves its hottest redirects from edge PoPs close to the user
- [Instagram](../../../designs/instagram.md) — global low-latency media delivery is exactly what a content delivery network (CDN) provides, fetching from origin only on a miss
- [Facebook Post Search](../../../designs/fb-post-search.md) — the design shows a content delivery network (CDN) absorbing duplicate search traffic before it reaches the origin
- [Google News](../../../designs/google-news.md) — pushing thumbnail bytes to the edge so most requests never reach the origin is exactly what a content delivery network (CDN) is for
- [Facebook Live Comments](../../../designs/fb-live-comments.md) — a comment snapshot is cacheable content served from edge locations, offloading the origin entirely under viral load
- [Dropbox](../../../designs/dropbox.md) — a content delivery network (CDN) fixes a single-region blob store being slow for distant users by caching files close to them
- [YouTube](../../../designs/youtube.md) — serving popular immutable media from the geographic edge is the content delivery network (CDN)'s defining use
- [Ticketmaster](../../../designs/ticketmaster.md) — shared, non-personalised query results are exactly the content a content delivery network (CDN) can safely cache close to users

**Implemented by**

- [Networking](../../../capabilities/networking.md) — A managed edge network is this pattern rented.

<!-- relationships:end -->
