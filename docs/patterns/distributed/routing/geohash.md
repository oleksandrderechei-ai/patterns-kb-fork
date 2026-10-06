---
title: Geohash
description: Encode a lat/long point into a short prefix-sortable key for range-scan nearest-neighbour
area: distributed-scale
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization, latency]
status: stable
aliases: [geo hash, geohashing]
solves: [I need to find all points near a location fast using an ordinary index, a 2-D nearest-neighbour query is slow without a special spatial index, how do I store locations so 'find things nearby' becomes a cheap range scan, my nearby-drivers query scans the whole table and times out, sorting by latitude then longitude still returns a huge band of far-away results]
---

# Geohash

A scheme that folds a two-dimensional point into one short, prefix-sortable string so nearest-neighbour and within-radius queries run as a plain range scan on an index the database already has — paid for by scanning a ring of neighbouring cells to catch matches that fall just across a cell boundary.

## What it is
<!--meta block=description-->

A geohash encodes a latitude and longitude as one short string by recursively splitting the globe into 32 cells, so a longer string names a smaller cell and a shared prefix means nearness. It answers what is near here with a prefix or range scan on an ordinary sorted index, which a two-column index cannot do. Points near a cell edge get different prefixes, so you scan a 3 by 3 ring and filter by exact distance.

## Explained
<!--meta block=explain-->

A geohash turns a latitude and longitude into one short string, so that places close together share the start of their string. The globe is split into 32 cells, each cell into 32 smaller ones, and each character names one choice, so more characters mean a smaller cell, from about 5 km at five characters to a few metres at nine. Because the key is plain text, finding what is near becomes a prefix scan on the sorted index your database already has. Without it, a normal index sorts on one column and cannot keep two-dimensional neighbours adjacent, so the database reads a wide band of rows and checks the distance on every one. Choose it over a dedicated spatial index when your data is mostly moving points, since an update is one small key write. Choose a spatial tree such as an R-tree when you need shapes like polygons.

- **Cell edges.** Close points can straddle an edge and get different prefixes, so scan the cell and its 8 neighbours, then filter by exact distance.
- **Uneven cells.** Cells ignore density and shrink toward the poles, so choose the prefix length by how crowded the area is.

**Example.** A ride app tracks 100,000 drivers who each report every 4 s, so 25,000 single-key writes a second. It stores each driver under a 6-character geohash, a cell about 1.2 km by 0.6 km. A rider asks for drivers within 500 m, under the 0.6 km cell height, so a ring of 9 cells always covers the radius. Scanning only the rider's cell would miss a driver 30 m away across the edge, so the app scans all 9. If a city cell holds about 20 drivers, that is 180 candidates, which the app narrows with exact distance. The cost is that extra scan and filter on every query.

## How it works
<!--meta block=structure-->

```mermaid caption="How does an ordinary sorted index answer \"what is near here\"? Step 2 collapses two dimensions into one sortable key, and steps 4 and 5 are inseparable — the scan narrows the planet to nine cells, and the distance check turns candidates into the answer."
flowchart LR
    Device["Moving device"]:::ext
    Svc["Location Service"]
    Client["Nearby query"]:::ext
    subgraph Narrow["Narrow to nine cells, then verify"]
        Index[("Sorted index on geohash key")]
        Filter["Exact-distance check"]
    end
    Device -->|"1 report lat/lon"| Svc
    Svc -->|"2 write encoded key"| Index
    Client -->|"3 ask for points within 2 km"| Svc
    Svc -->|"4 scan this cell + 8 neighbours"| Index
    Index -->|"5 candidate points"| Filter
    Filter -->|"6 points inside the radius"| Client
    classDef ext stroke-dasharray:4 4
```

## Variations
<!--meta block=variations-->

- **String vs. integer encoding** — Each base-32 character is five bits, so the same value is either text (a `LIKE 'dr5ru%'` prefix scan on a B-tree) or an interleaved integer (a numeric range scan). Both keep nearby points adjacent in sort order, but key width and precision differ, so lengths do not map one to one. Redis keeps a 52-bit integer on a sorted-set score and Postgres can keep text; Redis's integer is its own variant, so do not mix its values with standard geohash strings.
- **Precision by prefix length** — Cell size shrinks with each added character — roughly 5 km at five characters, a few metres at nine. Choose a length that matches your search radius so the neighbour ring stays small and the candidate set stays cheap to post-filter.
- **S2 (Google) — spherical cells on a Hilbert curve** — Geohash treats latitude and longitude as a flat rectangle, so its cells distort by latitude (wide near the equator, narrow near the poles). S2 projects the sphere onto the six faces of a cube and threads a Hilbert space-filling curve through them, giving cells of roughly uniform area anywhere on Earth and 64-bit hierarchical ids that truncate to a parent cell. It also models the sphere, so it handles shapes that cross the antimeridian.
- **H3 (Uber) — a hexagonal grid** — Uses hexagonal cells instead of squares: a hexagon has six neighbours all at roughly equal distance, which is cleaner for "N rings out" queries and heatmap analytics than a square's mix of edge and corner neighbours. Its 64-bit ids are not laid out along a space-filling curve, so instead of a range scan you call grid-math functions to compute the ring of neighbour cell ids and look them up explicitly with an `IN` list. Hexagons also cannot tile hierarchically: a finer cell is not wholly inside the coarser one it names as its parent, so counts rolled up across resolutions are approximate. That is the price H3 pays for the even neighbour distances.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Reuses the B-tree** or sorted-set index every database already ships — no dedicated spatial extension to install and operate.
- **Cheap location updates** — with the hash in the key, an update is one short key write while the point stays in its cell. A move into a new cell is a delete plus an insert, so moving points still cost more than static ones.
- **A shared prefix means the same bounded cell**, so "nearby" is a cheap prefix or range scan over a few cells rather than a full-table distance computation; close points can still differ in prefix (see the first con).
- **Prefix length tunes precision on the fly** — coarser or finer cells without rebuilding any structure.

### Cons
<!--meta polarity=con-->

- **Cell boundaries break naive queries**: two close points can differ in prefix, so a correct search must scan the cell plus its eight neighbours and post-filter by exact distance.
- **It encodes points only** — it cannot represent a line or a polygon, so containment and intersection questions need a real spatial tree instead.
- **The flat latitude/longitude grid distorts** cell area toward the poles, so S2 and H3 trade this for near-uniform cell area at other costs (see variations).
- **A fixed grid ignores density** — a cell in a dense city holds far more candidates than a rural one, so you post-filter more where data is thickest.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Your data is mostly moving points** — drivers, live users, devices — updated constantly, and you want each update to be a cheap key write.
- **You want proximity search** on a plain key-value store or relational index without adopting a spatial extension.
- **The question is point-and-radius** ("what is within N km of here"), not polygon containment.
- **You want to shard or colocate nearby points**, using the prefix as a locality-preserving partition key.

### Avoid when
<!--meta polarity=avoid-->

- **You need true geometry** — polygon containment, line intersection, "is this address inside this delivery zone" — where an R-tree (PostGIS) is the right tool.
- **Uniform cell area across latitudes matters**, for example spatial analytics that compares counts per cell — prefer S2 or H3.
- **The data is static geometry** managed inside the database — a BKD or R-tree index built for shapes fits better than an encoded key.

## Code sketch
<!--meta block=sketch-->

```sql summary="SQL — a \"nearby\" query is a prefix scan over the 3×3 ring"
-- Each row stores its point's geohash once, written at insert time,
-- plus geohash6, its first 6 characters, under a plain B-tree index.
-- Nearby points share a prefix, so proximity becomes a string match.
-- :cells is the caller's own cell plus the 8 around it, at precision 6.

SELECT id, lat, lon
FROM places
WHERE geohash6 IN (:cells)   -- one index lookup per cell, not a table scan

-- Then drop rows whose real haversine distance exceeds the radius:
-- the index gives candidates, exact distance gives answers.
```

```typescript summary="TypeScript — how that string is produced: interleaved bit bisection"
// Geohash's base-32 alphabet (no a, i, l, o — easy to misread).
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

// Interleave lon/lat bits by bisecting each range in turn.
function geohash(lat: number, lon: number, precision = 9): string {
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let hash = "", bits = 0, ch = 0, even = true; // longitude first

  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonLo = mid; }
      else            { ch = ch << 1;        lonHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; }
      else            { ch = ch << 1;        latHi = mid; }
    }
    even = !even;
    if (++bits === 5) { hash += BASE32[ch]; bits = 0; ch = 0; }
  }
  return hash;
}

// Longer prefix, smaller cell: 6 characters is roughly a 1.2 km box,
// 9 characters roughly 5 m. Precision is the dial the query above scans on.

```

## In the wild
<!--meta block=wild-->

- **Redis geospatial** — GEOADD encodes a longitude/latitude pair into a 52-bit geohash integer and stores it as the score of a sorted set; GEOSEARCH (and the older GEORADIUS) then returns members within a radius or box — a range scan over those scores. {#wild-redis-geo}
- **Elasticsearch geohash_grid** — The geohash_grid aggregation buckets documents by geohash cell at a chosen precision, and geo_point fields answer geo_distance and geo_bounding_box queries — the same encode-then-scan idea over its index. {#wild-elasticsearch-geohash-grid}
- **Google S2** — The s2geometry library models Earth as cells on a Hilbert space-filling curve over the six faces of a cube, giving roughly uniform-area cells and 64-bit hierarchical ids; it is the cell system underneath MongoDB's 2dsphere index. {#wild-google-s2}
- **Uber H3** — An open-source hexagonal hierarchical geospatial index: each cell is a 64-bit id with grid-traversal functions to walk the ring of neighbours. Uber uses it operationally for dispatch and surge pricing. {#wild-uber-h3}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Prefix length (precision)** — How many characters of the hash you index and match on; each added character subdivides the cell into 32. Pick the longest prefix whose smaller cell side is at least your radius: a 6-character cell is about 1.2 km by 0.6 km, so one ring serves radii up to about 0.6 km.
- **Encoding: string or integer** — The same value indexes either as text for a prefix scan or as the interleaved bits read as a number for a numeric range scan — pick whichever matches the index the store already runs.
- **Neighbour ring width** — How many rings of surrounding cells a query scans. One ring — the cell plus its eight neighbours — is the standard correction for the boundary problem; a radius large relative to the cell needs more.
- **Candidate cap per query** — A bound on how many rows the scan may return before the exact-distance post-filter runs, so a dense cell cannot hand the post-filter an unbounded candidate set. A cap that trips drops true matches and returns wrong answers, so prefer a longer prefix or a paged scan, and count every truncation.

### Signals to watch
<!--meta polarity=signal-->

- **Candidate set size per query** — Rows returned by the cell scan before post-filtering, against rows actually within the radius — the ratio is how much work the index is wasting.
- **Post-filter discard rate** — The share of scanned candidates thrown away by the exact-distance check; a rate climbing over time means the prefix length no longer matches the radius being asked for.
- **Query latency by region** — Read latency split by area rather than averaged, since a dense city cell and an empty rural one do very different amounts of post-filtering.
- **Points per cell skew** — Maximum against median occupancy across cells — the spread that tells you whether a fixed grid is still an acceptable fit for the data.

### Failure modes under load
<!--meta polarity=failure-->

- **Dense-cell post-filter blowup** — A cell over a city centre holds far more candidates than a rural one, so the same query does much more distance math exactly where traffic is heaviest.
- **Radius outgrows the cell** — A search radius large relative to the cell size pulls in rings of neighbours well beyond the standard nine, and the candidate set grows with the area scanned.
- **Boundary misses** — A query that scans only the point's own cell silently omits neighbours a few metres away on the far side of a cell edge — wrong answers rather than slow ones.
- **Shard hotspot on the prefix** — Using the prefix as a partition key colocates nearby points by design, so a dense region concentrates its load onto one partition.
- **Latitude distortion** — The flat latitude/longitude grid makes cells vary in real area toward the poles, so one prefix length does not mean one ground distance everywhere.

### Readiness checklist
<!--meta polarity=check-->

- Scan the cell plus its eight neighbours and post-filter by exact distance — never the single cell alone.
- Compute prefix length from the search radius you serve, and re-check it when that radius changes.
- Bound the candidate set per query so one dense cell cannot hand the post-filter unbounded rows.
- Match the encoding — text or integer — to the index the datastore already operates.
- If the prefix doubles as a partition key, measure the densest region's share before going live.
- Where per-cell counts are compared against each other, use a uniform-area system instead.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Proximity Search](../../../themes/proximity-search.md) — Encode space into a sortable key so a plain index answers nearby {#fluency-proximity-search}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Sharding](./sharding.md) — Shard geo data by geohash prefix so nearby points land on the same partition
- [Trie](../coordination/trie.md) — Shared prefix means same cell, the property a prefix tree exploits

**Demonstrated by**

- [Yelp](../../../designs/yelp.md) — two-dimensional lat/long proximity needs a geospatial encoding, not a single-dimension range index
- [Uber](../../../designs/uber.md) — proximity search over a stream of live coordinates is exactly what a geohash index makes fast
- [Tinder](../../../designs/tinder.md) — the feed's 'nearby people' retrieval is exactly the bounded spatial lookup a geohash index makes fast
- [Gopuff](../../../designs/gopuff.md) — a delivery network prunes candidate warehouses by cell before it pays for a single drive-time call

<!-- relationships:end -->
