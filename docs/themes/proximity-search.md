---
title: Proximity Search
description: Answering 'what is near this location' without scanning everything
area: themes-data
owner: Oleksandr Derechei
tags: [data-modeling, read-optimization, latency]
status: stable
aliases: [geospatial search, nearby search]
---

# Proximity Search

A one-dimensional index cannot preserve two-dimensional adjacency, so "what is near here" is answered one of two ways — walk a true spatial tree, or encode space into sortable keys — and either way it finishes with an exact-distance post-filter over a small candidate set. This is the lens for choosing between those families and the patterns that carry them.

## The question
<!--meta block=description-->

Proximity search queries by location: the nearest driver, restaurants within two kilometres, friends nearby. The index you already trust fails at it, because a one-dimensional sort order cannot keep two-dimensional neighbours adjacent. Two families answer it, a spatial tree or a location encoded as one sortable key, and both only narrow the candidates, so you always finish with exact distance math.

## Explained
<!--meta block=explain-->

Proximity search finds the things nearest a point, such as drivers within 1 km, and an ordinary index cannot do it. An index sorts on one value, and a location has two, so points that are neighbours on the map can sit far apart in the sort. There are two fixes. Choose a spatial tree, an index that nests boxes inside bigger boxes, when you store shapes such as delivery zones and ask whether a point is inside one. Choose an encoded cell, which a [geohash](../patterns/distributed/routing/geohash.md) makes by turning a location into one short key for its grid square, when you store points that move constantly, because an update is one small key write. Large sets spread across machines by [sharding](../patterns/distributed/routing/sharding.md) on that key. Without either, you compute distance on every row.

- **Candidates, not answers.** The index only narrows the search. Finish with an exact distance calculation on the candidates.
- **Edge misses.** An edge point's neighbours sit in the next square. Scan the square and its 8 neighbours, cells at least the radius wide.
- **Points only.** Encoded cells suit points, not shapes. Keep a spatial tree for zones and polygons.

**Example.** A ride app tracks 200,000 drivers who report every 4 s, which is 50,000 writes a second. Each write updates the driver's entry in an index keyed by cell, moving it when the driver crosses a cell edge. A rider asks for drivers within 1 km. With cells 1 km wide, the app scans the rider cell and its 8 neighbours, about 20 drivers per cell, so 180 candidates, and computes exact distance on those 180, not on 200,000. A dispatcher also asks whether a pickup is inside an airport zone, a polygon, which an encoded cell does not answer directly, so that query goes to a spatial index in PostGIS.

## The trade-space
<!--meta block=tradespace-->

The answers come in two families, and they divide by the **shape of the data**. Geometric data — polygons, roads, delivery zones, where you ask containment and intersection questions — wants a spatial tree. Point data that updates constantly — drivers, live users, devices — wants an encoded cell on an ordinary index.

**Spatial trees** are purpose-built structures reshaped to behave like a B-tree on disk: balanced, page-sized nodes, predictable depth. They come as a progression, each fixing the previous one's flaw. A **quadtree** recursively splits each overfull cell into four quadrants, so it adapts to density — a dense city subdivides deeply while open ocean stays one coarse cell — but it always cuts at the geometric midpoint regardless of where the data actually sits, so its depth (and latency) is location-dependent, and as a pointer-chasing structure it goes disk-bound at scale. It stays excellent in memory (map tiles, game collision detection). A **k-d tree** fixes the balance problem by alternating the split axis per level and cutting at the median point rather than the midpoint, staying balanced at depth about log n regardless of skew; its **BKD (block k-d) tree** variant groups points into page-sized blocks built once in a batch — so it suits data that rarely moves. Elasticsearch's geo fields are built on a BKD tree. The **R-tree** was the first spatial index designed from scratch for on-disk database use: it wraps every object — a point, a highway, a county polygon — in a Minimum Bounding Rectangle, nests nearby rectangles under larger ones, and keeps every leaf at the same depth like a B-tree. That is what lets it narrow a query to real shapes: is this address inside this delivery zone, does this road cross this county, before the exact test. Its rectangles can overlap, so a query point inside two boxes forces descending both subtrees; the **R\*-tree** refines the insertion heuristic to minimise that overlap and is the basis of common implementations. Moving a point in an R-tree means deleting and reinserting it, which can split or rebalance nodes; an encoded cell takes one key write. PostGIS builds its spatial index on Postgres's GiST framework, giving R-tree-style bounding-box behaviour over points, lines, and polygons alike.

**Encoded cells** skip the custom tree entirely: convert `(lat, lon)` into one sortable cell id and use it with a plain existing index, reusing infrastructure every database already ships. **Geohash** threads a space-filling curve through 2-D space and flattens each point to a short base-32 string, so a shared prefix means the same cell and a "nearby" query is a prefix or range scan; Redis stores it as a 52-bit integer on a sorted-set score. **S2** (Google) answers geohash's biggest weakness — a flat lat/lon grid distorts cell area badly by latitude — by projecting the sphere onto the six faces of a cube along a Hilbert curve, giving roughly uniform-area cells and 64-bit hierarchical ids; it backs MongoDB's `2dsphere` index. **H3** (Uber) uses hexagonal cells, whose six neighbours are all roughly equidistant — cleaner for "N rings out" queries and heatmap analytics — and is used operationally for dispatch and surge. Their shared virtue is cheap writes: a moving driver's location update is a single small key write, which keeps up with the 50,000 writes a second in the ride-app example.

Two things are present no matter which family you choose. First, the **exact-distance post-filter**: the index gives candidates, never answers, so you always finish with real distance or geometry math on the small set. Second, the **cell-boundary problem**: a point near the edge of its cell has near neighbours sitting in adjacent cells, so a correct query scans a ring of neighbouring cells — the 3×3 ring for a grid scheme — rather than a single exact cell. Encoded cells are also effectively points-only; representing a shape still calls for a tree. The [Uber](../designs/uber.md), [Yelp](../designs/yelp.md) and [Tinder](../designs/tinder.md) case studies each put these indexes to work.

```mermaid caption="The index choice forks on data shape — trees for geometry, encoded cells for moving points — but both return candidates an exact-distance post-filter must confirm."
flowchart TB
    Q{"Shape of the data?"}
    Q -->|"polygons, containment, intersection"| T["Spatial tree — R-tree / BKD"]
    Q -->|"points, constant updates"| C["Encoded cell — geohash / S2 / H3"]
    T -->|"candidates, never answers"| PF["Exact-distance / geometry post-filter"]
    C -->|"candidates + 3×3 ring for edge points"| PF
```

## Patterns that carry the load
<!--meta block=tour-->

<!-- tour:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

### [Geohash](../patterns/distributed/routing/geohash.md) {#tour-geohash}

The encoded-cell answer. Flatten each point to a short, prefix-sortable key so nearest-neighbour becomes a range scan on the B-tree or sorted set you already have. It costs a scan of the 3×3 ring of neighbouring cells and an exact-distance post-filter. Cheap single-key writes make it the natural home for constantly moving points. S2 and H3 are the same idea with uniform-area or hexagonal cells; a hex grid scans its 6 neighbours instead.

### [Trie](../patterns/distributed/coordination/trie.md) {#tour-trie}

A prefix tree finds every cell or term that starts with a given prefix by walking one path. Paired with a geohash, the shared prefix means the same neighbourhood.

### [Materialized View](../patterns/distributed/coordination/materialized-view.md) {#tour-materialized-view}

The post-filter is the expensive half, and you can skip it when nothing moves. If a business never changes address and a neighbourhood boundary never changes shape, run the polygon test once when the row is written and store the answer — the cell id, the zone name — as an indexed column. A repeated geometry check becomes a column read, at the cost of a rebuild whenever a boundary is redrawn. It buys you nothing for a user-centred radius query, because the centre is a new point on every request.

### [Sharding](../patterns/distributed/routing/sharding.md) {#tour-sharding}

At scale one node cannot hold the whole map or absorb every location update. Partition the space itself, by geohash prefix or by region, so nearby points colocate on the same shard and a local-area query usually touches one shard, more when it crosses a shard boundary. An encoded cell key doubles as a locality-preserving shard key. The cost is skew: a dense city loads one shard far more than empty ocean, so split busy prefixes into longer ones.

<!-- tour:end -->

## How to decide
<!--meta block=decide-->

| If your situation is… | Reach for | Why |
| --- | --- | --- |
| Points that move constantly (drivers, live users), huge update rate | Encoded cells — [geohash](../patterns/distributed/routing/geohash.md) / S2 / H3 on an ordinary index | Each update is one small key write; candidate generation is a prefix or ring scan |
| Point-and-radius "what is within N km" on a key-value store | Geohash on a sorted set (e.g. Redis geo) | Reuses the index you already run; scan the 3×3 ring, then post-filter |
| Polygon containment or line intersection ("is this inside the zone") | Spatial tree — R-tree via PostGIS / GiST | Trees store shapes directly; the index narrows containment and intersection to a few candidates, then an exact test confirms |
| Static or DB-managed geometry, mixed points, lines, polygons | R-tree (PostGIS) or BKD (Elasticsearch) | Balanced on-disk index built for shapes; BKD is built once in a batch, so it fits data that rarely moves |
| Both the object and the region are fixed — "which neighbourhood is this in" | Resolve it at write time into a [materialized view](../patterns/distributed/coordination/materialized-view.md) | Turns a repeated polygon test into a column read; gives nothing back once either side moves |
| Uniform cell area across latitudes, "N rings out" analytics | S2 (uniform area) or H3 (hexagonal rings) | Flat geohash cells distort by latitude; hexagons give equidistant neighbours |
| The location index outgrows one node | [Shard](../patterns/distributed/routing/sharding.md) the space by region or geohash prefix | Colocate nearby points so a local-area query usually stays on one shard; dense cells make a [hot partition](../hazards/hot-partition.md), so split busy prefixes |

The mnemonic: **a spatial tree for shapes, encoded cells for moving points, and always post-filter.**

## Related areas
<!--meta block=siblings-->

- [Scalability](./scalability.md) — Sharding and replicating the location index is what keeps proximity search working across millions of constantly moving points.
- [Performance](./performance.md) — The whole game is turning a full scan into a small candidate set — proximity search is a read-optimisation problem at heart.
- [System Design Interview](./system-design-interview.md) — "Design Uber", "design Yelp", "find nearby" are recurring prompts, and this is the toolkit for answering them.
