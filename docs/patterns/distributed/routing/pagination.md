---
title: Pagination
description: Hand back a large collection in bounded slices the caller asks for one at a time
area: distributed-routing
owner: Oleksandr Derechei
tags: [api-design, read-optimization, data-access]
status: stable
aliases: [paging, cursor pagination, keyset pagination]
solves: [a list endpoint times out because the table grew past a million rows, the export job re-reads the same record and misses another one entirely, page 900 of the search results takes twelve seconds and page 1 takes forty milliseconds, one client asked for limit=100000 and took the database down, the total count on the results page costs more than the results]
---

# Pagination

Splits a collection nobody can afford to return whole into bounded pages, and gives the caller a way to ask for the next one. The choice of what marks the boundary — a row count to skip, or the last row you saw — decides whether page ten thousand costs the same as page one, and whether a concurrent write makes a row appear twice or not at all.

## What it is
<!--meta block=description-->

Pagination returns a collection a slice at a time: the caller states how many items it wants, and the response carries what it must send back for the next slice. Offset paging skips some items, and keyset paging seeks past the last item seen. Offset reads and discards every skipped row, while keyset costs the same on every page. The cursor a public API hands out is usually an opaque token encoding the sort key and filters.

## Explained
<!--meta block=explain-->

Pagination returns a large collection a slice at a time: the caller says how many items it wants, and the response carries what the caller sends back to get the next slice. Offset paging has the caller say how many items to skip; keyset paging has it say which item it saw last. Choose by how deep the traversal goes. A person browsing filtered results rarely passes page five, so offset is fine and gives the page-number control the screen wants. An export, a sync job or an endless scroll walks everything, and only keyset keeps the last page as cheap as the first, because it seeks straight to the right place in the index while offset reads and throws away every skipped row.

- **Offset drift.** A mid-walk insert shifts later pages and repeats or skips a row, so pin a snapshot or make the consumer safe to repeat.
- **No page jumps.** Keyset cannot jump to page 50, so hand out an opaque signed cursor and keep offset for the first few pages.
- **Total counts.** A total count is a full scan, so approximate it.
- **Unbounded pages.** An unlimited limit is an attack you published, so cap page size at the gateway.

**Example.** A table holds 4,000,000 rows and the page size is 25. Offset paging to the page starting at row 2,000,000 reads and discards 2,000,000 rows to return 25, while keyset paging seeks and reads 25. Drift: a client has read rows 51 to 75 and asks for offset 75. A new row was inserted at the top meanwhile, so everything shifted by one and row 75 comes back a second time. The cost of keyset is that the client gets a cursor and no page numbers, so you keep offset for the first few pages.

## How it works
<!--meta block=structure-->

```mermaid caption="How does the caller get page two without the server remembering page one? The cursor travels in the response and comes back in the next request, so every page is a fresh stateless seek — and the twenty-sixth row is read only to answer whether there is more."
flowchart LR
    C["Client"]:::ext
    subgraph Seek["One page — a seek, never a scan"]
        API["List endpoint"]
        IDX[("Ordered index<br/>created_at, id")]
    end
    C -->|"1 GET /orders?limit=25"| API
    API -->|"2 seek past the cursor, read 26"| IDX
    IDX -->|"3 25 rows plus one lookahead"| API
    API -->|"4 200 items, next_cursor, has_more"| C
    C -->|"5 next page: echo next_cursor back"| API
    classDef ext stroke-dasharray:4 4
```

```mermaid caption="What breaks when the collection changes mid-walk? Offset counts positions, and an insert moves every position after it — so the client re-reads one row and silently skips another. Keyset paging asks for \"everything after this key\": it never repeats or skips a row it has already passed, though a row inserted behind the cursor is never seen."
sequenceDiagram
    participant C as Client
    participant A as List endpoint
    participant D as Store
    C->>A: GET /orders?limit=25&offset=0
    A->>D: skip 0, take 25
    D-->>A: rows 1..25
    A-->>C: rows 1..25
    Note over D: a new order is inserted<br/>and sorts to position 1
    C->>A: GET /orders?limit=25&offset=25
    A->>D: skip 25, take 25
    D-->>A: rows 25..49 of the NEW order
    A-->>C: row 25 arrives twice, row 50 never arrives
```

## Variations
<!--meta block=variations-->

- **Offset paging** — The caller sends how many rows to skip and how many to take — `?limit=25&offset=50` — with defaults for both. Any page is addressable, so a numbered page control and a "jump to last" button both work, which is why nearly every interface starts here. The store still walks the skipped rows, so latency grows with depth, and a concurrent insert or delete shifts every page after it.
- **Keyset paging** — The caller sends the sort key of the last row it saw, and the query seeks past it on the index. Cost is flat no matter how deep the walk goes, and rows already returned cannot shift under a concurrent write. You give up random access — there is no page seven — and you need a sort key that is a total order, which usually means appending a unique id as the tie-breaker.
- **Opaque page token** — The server encodes the cursor state — sort key, active filters, sometimes a snapshot id — into a single string the client only ever echoes back. It keeps the paging strategy private, so you can move from offset to keyset without a client release, and it stops callers hand-crafting cursors that skip the filters. Sign or encrypt it: an unsigned token is user input that reaches your query planner.
- **Snapshot paging** — The first request pins a consistent view, such as a read timestamp or a search index point-in-time, and every later page reads that version. Drift disappears entirely, which is what a correct export needs. The price is a resource held open for the length of the walk, and a client that stops halfway leaves it there until it expires, so the lifetime has to be short and enforced. An open database transaction fits only a server-side cursor on one connection, since it cannot span separate HTTP requests without pinning locks and vacuum.
- **Byte-range paging** — The same idea applied to one large object rather than a collection. The response advertises `Accept-Ranges: bytes` and a total `Content-Length`, the client asks for `Range: bytes=0-2499`, and the server answers `206 Partial Content` with a `Content-Range`. It is how a resumable download survives a dropped connection — the client restarts from the last byte it has, not from zero.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Response size** is bounded, and so is query cost under keyset paging on an indexed sort key, so one caller can no longer take the service down by asking a reasonable question. Deep offset and cross-shard merges still grow with depth and shard count.
- **The caller sees the first** results in milliseconds instead of waiting for a complete answer it will mostly discard.
- **Each page is an independent stateless request**, so pages can be retried, load-balanced across instances, and cached on their own.
- **Keyset paging** makes the last page as cheap as the first, which is what makes a full-collection sync or export viable at all.

### Cons
<!--meta polarity=con-->

- **A collection that changes** while the caller walks it can deliver a row twice or skip one entirely: offset paging always, keyset paging for rows not yet reached. A row whose sort key changes mid-walk moves across the cursor, so sort on an immutable column such as created_at.
- **Every consumer now has a loop**, a termination condition and a retry story where it used to have one call.
- **Total count costs a second scan** — a second full scan of the filtered set, so "showing 1-25 of 4,182,993" costs more than the page it decorates.
- **Keyset paging gives up random access**: there is no page seven, and no jump to the end.
- **Paging a collection** spread over shards fetches offset plus limit rows from each shard and merges them, so the work grows with depth and shard count while the response stays the same size. Keyset paging cuts it to limit rows per shard.
- **Cursors are a compatibility surface**: change the sort order or the filter semantics and every cursor already in a client's hands is wrong.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **A collection endpoint has no upper bound** on how many rows it can return.
- **Callers want the first results** quickly and rarely need the rest.
- **Something walks the whole collection on a schedule** — an export, a sync, a reindex — and must not depend on it being small.
- **You need a bound** you can enforce at the edge on what any single request may cost.

### Avoid when
<!--meta polarity=avoid-->

- **The collection is small and bounded by construction** — a country list, a user's payment methods.
- **The caller needs the whole** set atomically to compute an answer, where a bulk export or a stream is the honest interface.
- **The data is a continuous** feed rather than a collection, where a subscription with an offset — a log, an event stream — already does this better.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — keyset paging with a lookahead row and an opaque cursor"
const MAX_LIMIT = 100;   // published, enforced — an uncapped limit is a DoS parameter

type Cursor = { createdAt: string; id: string; customerId: string };

// Opaque on purpose: signed, so clients cannot hand-craft one that skips filters.
// sign/verify: HMAC with a server-side key. The filter rides in the token.
const encode = (c: Cursor) => sign(Buffer.from(JSON.stringify(c)).toString("base64url"));
function decode(t: string, customerId: string): Cursor {
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(verify(t), "base64url").toString());
  } catch {
    throw new BadRequest("invalid_cursor");
  }
  if (c.customerId !== customerId) throw new BadRequest("invalid_cursor");
  return c;
}

async function listOrders(customerId: string, q: { limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? 25) || 25), MAX_LIMIT);
  const after = q.cursor ? decode(q.cursor, customerId) : undefined;

  // (created_at, id) is a TOTAL order. created_at alone lets rows with an
  // identical timestamp repeat or vanish across a page boundary.
  // created_at::text keeps microseconds; a JS Date truncates to ms and the tuple compare repeats rows.
  // Check EXPLAIN shows an index range scan; if the OR defeats the seek, run two queries.
  const rows = await db.query(
    `SELECT id, created_at::text AS created_at, total FROM orders
      WHERE customer_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [customerId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
  );

  // One extra row answers "is there more" without counting anything.
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const next_cursor = hasMore && last ? encode({ createdAt: last.created_at, id: last.id, customerId }) : null;
  return { items, has_more: hasMore, next_cursor };
}
```

## In the wild
<!--meta block=wild-->

- **Stripe API** — Cursor pagination across every list endpoint: `limit` bounds the page, `starting_after` and `ending_before` carry an object id rather than an offset, and `has_more` tells the caller whether to continue. No total count is returned. {#wild-stripe}
- **GitHub representational state transfer (REST) API** — Offset paging with `page` and `per_page`, and the next page advertised in a `Link` header with `rel="next"`, `rel="prev"` and `rel="last"` — so a client follows links instead of computing offsets. {#wild-github}
- **Elasticsearch** — Deep paging is capped rather than merely discouraged: `from` plus `size` may not exceed `index.max_result_window`, which defaults to 10,000. Past that you use `search_after`, pinned to a point-in-time so the traversal reads one consistent view. {#wild-elasticsearch}
- **Kubernetes API** — List requests take a `limit` and return a `continue` token that the next request echoes back: an opaque cursor whose encoding the API server is free to change. A token that outlives the server's retained history is rejected with `410 Gone`, and the client must restart the list. {#wild-kubernetes}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Default and maximum page size** — What an omitted `limit` means and the largest value you will honour. Publish both; an uncapped limit is a denial-of-service parameter, and clamping silently is friendlier than rejecting.
- **Sort key tuple** — The columns the page boundary is drawn on. Append a unique id as the last element, or rows sharing a timestamp repeat or vanish across the boundary.
- **Cursor encoding and signature** — What goes into the token and how it is protected. Include the filters, so a caller cannot swap them mid-walk, and sign it, because an unsigned token is user input that reaches the query planner.
- **Total-count policy** — Whether the response carries an exact count, an estimate, or only `has_more`. An exact count is a second full scan of the filtered set on every page.
- **Snapshot lifetime** — How long a pinned read view is held for a paging client. Long enough for an honest export, short enough that an abandoned walk does not pin resources indefinitely.

### Signals to watch
<!--meta polarity=signal-->

- **Latency by page depth** — Response time bucketed by offset or page number. Offset paging shows a clean upward slope here; keyset paging shows a flat line, which is the whole point of it.
- **Rows examined per row returned** — How much the store read to produce the page. A ratio far above one is a scan wearing a page-shaped hat.
- **Largest requested limit** — The maximum `limit` seen in a window. It shows whether the published cap is actually enforced at the edge.
- **Rejected or expired cursor rate** — Requests answered with an invalid-cursor error. A step change follows a sort-order change or a token-format deploy.

### Failure modes under load
<!--meta polarity=failure-->

- **Deep-offset scan saturates the store** — A crawler walks to page 50,000 and each request reads millions of rows. CPU on the database climbs while the response size stays constant, so request-rate dashboards show nothing unusual.
- **Silent gaps in a full-collection walk** — Writes during an offset-paged export shift the later pages, so the consumer receives one row twice and never receives another. Nothing errors and the output looks complete.
- **Unbounded limit as an amplifier** — One caller sends a very large `limit` and a single request allocates a response big enough to exhaust the process. Enforce the cap at the edge, not only in the handler.
- **Cursors invalidated by a deploy** — A change to the sort order or filter semantics makes every token already in flight meaningless, so every in-progress traversal restarts at once.
- **Cross-shard merge cost** — Paging a collection spread over shards fetches a page from each and merges, so work grows with shard count while the response stays the same size.

### Readiness checklist
<!--meta polarity=check-->

- A default page size and a hard maximum are documented and enforced
- The sort key is a total order, with a unique tie-breaker as its last element
- Cursors are opaque and signed, and carry the filters they were issued under
- The index supports the sort key as a seek rather than a scan
- Anything that walks the whole collection uses keyset paging, not offset
- Consumers are idempotent, so a repeated row on a page boundary is harmless
- The behaviour of an expired or malformed cursor is defined and tested

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../../themes/api-design.md) — Bound what one request can return, however much data exists {#fluency-api-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [API Gateway](./api-gateway.md) — The page-size cap belongs at the front door, where it is enforced before a request reaches your handler
- [Rate Limiter](../resilience/rate-limiter.md) — A page cap bounds one request; a rate limit bounds the sequence of them, and a walk needs both
- [Scatter-Gather](../../messaging/scatter-gather.md) — Paging a collection spread over shards means a page from each shard and a merge before the answer

**Prevents**

- [Extraneous Fetching](../../../hazards/extraneous-fetching.md) — Returning bounded slices fixes the cost of a read, whatever the collection has grown to

<!-- relationships:end -->
