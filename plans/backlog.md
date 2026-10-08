# Backlog

Ideas and open questions that have no phase yet. None of them blocks the KB, and each list
is ordered roughly by value to effort. A plain list with no gate: one bullet per item,
deleted when it ships or is dropped. A trap, something that bit a session, goes to the
[inbox](../docs/inbox.md) instead, where a gate caps it.

## Features

- A skill that uses the case studies as references to successful designs.
- From the kb-improve pilot (its pull request, #30, has the findings):
  - a `kb.mjs get <id> --block solves` read, so reviewers can judge the symptom phrases;
  - an `architecture` block for the `resilience` theme and a `sketch` block for `kiss`;
  - the edges drafted but over the cap: `distributed-monolith` to `aggregate` and to
    `chatty-io`;
  - an owner call on whether `alternative-to` may record a rejected option, which three
    drafted `bitly` edges wait on (`refresh-ahead`, `sweeper`, `idempotency`);
  - the first run of `.claude/workflows/kb-improve-batch.mjs`, on two pages.
- From the kb-improve run on the Testing area (its pull request lists every dropped finding):
  - a `testing` theme decide row that routes "no tests, output too large to assert" to
    `golden-master`, which no row reaches today;
  - pages readers wanted to send people to but the KB lacks: Object Mother, property-based
    testing, integration testing;
  - edges drafted but over the cap: `dummy-object` often-confused-with `fake-object` and
    `test-spy`, `page-object` combines-with `lazy-initialization`, `test-stub` combines-with
    `dependency-injection`.
- From the kb-improve run on the Security area (its pull request lists every dropped finding):
  - production numbers readers asked for that need a named source before they land:
    starting rate limits and gateway timeouts (`single-access-point`), refresh-token and
    access-token lifetimes and a session-id entropy floor (`secure-session-manager`),
    dormant-grant windows and review cadence (`least-privilege`), alert baselines on
    `agent-sandboxing`, `quarantine` and `intercepting-validator`;
  - variations drafted but over the cap: canonicalize-then-validate
    (`intercepting-validator`), identity-aware proxy (`single-access-point`), digest-pinned
    publish (`quarantine`), usage-driven right-sizing (`least-privilege`);
  - wild items a reader could not vouch for: product claims on Cloudflare Access, Teleport,
    JFrog and Docker agent sandboxes, the macOS sandbox profile, and STS role-chaining caps;
  - `intercepting-validator` production-failure-2 still says "blacklist";
  - edges drafted but over the cap: `secure-session-manager` alternative-to `sticky-session`,
    `single-access-point` with `front-controller`, retyping `intercepting-validator` to
    `gatekeeper` and `quarantine` as often-confused-with.
- From the kb-improve run over the 44 hazard pages (its pull request lists every dropped
  finding):
  - a sourcing pass for the 88 findings dropped as "needs a source": alert thresholds,
    pool, timeout and queue sizing, clock drift rates and product defaults that readers
    asked for in the mitigation blocks;
  - a second pass for the 164 findings dropped as over the cap of 8, mostly wording;
  - full stops on three `metastable-failure` notes (`cache-aside`, `message-queue`,
    `failover`), each an unlink then link;
  - an owner call on whether a hazard's mitigation block may hold list items, which
    agent-consumer readers asked for on several pages so a citation can name one fix.
- From the kb-improve run on the Foundational case studies (its pull request lists every
  dropped finding):
  - a sourcing pass for the 35 plan lines dropped as "needs a source": a Redis-call timeout
    and per-route fail-open (`distributed-rate-limiter`), vnode counts and a hot-key
    threshold (`design-distributed-cache`), sketch width and precompute cadence (`top-k`),
    a `robots.txt` refresh interval and links per page for URL-dedup sizing
    (`web-crawler`), a cardinality cap and lateness window (`metrics-monitoring`), alias
    rules and a negative-cache TTL (`bitly`);
  - a citation for Mercator's "up to 70%" DNS share (`web-crawler`) and for "Stripe uses
    this shape" (`distributed-rate-limiter`), or softer wording;
  - decide rows that never reach these designs: `observability` to `metrics-monitoring`,
    and `spike-handling`'s Rate Limiter row to `distributed-rate-limiter`;
  - edges drafted but over the cap: `bitly` to `request-coalescing` and `refresh-ahead`,
    `distributed-rate-limiter` to `fail-fast` and `sliding-window`, `top-k` to
    `request-coalescing`; and the `logging-service` to `monitor-object` note, which still
    says a slow file cannot block the console;
  - a page for the SCAN and LOOK scheduling algorithms, which `elevator` names but cannot
    link;
  - a second pass for the 96 plan lines dropped as over the cap of 8, mostly wording and
    one-claim-per-item splits.
- From the kb-improve run on the nine remaining concurrency patterns (its pull request lists
  every dropped finding):
  - `concurrency` theme decide rows that never reach `channels`, `active-object`, `mutex`
    or `double-checked-locking`, and `reactor` missing from the row that routes to
    `proactor`;
  - `production` blocks for `active-object` (queue depth, request wait, scheduler use) and
    `ring-buffer` (drops, high-water fill, consumer lag);
  - edges drafted but over the cap: `proactor` combines-with `backpressure`, `object-pool`
    and `thread-confinement`, `ring-buffer` alternative-to `mutex`, `double-checked-locking`
    alternative-to `monitor-object`, `fork-join` exposed-to `starvation`; and two notes to fix
    in place: `proactor` to `synchronous-io` ("with a kernel proactor no thread waits") and
    the `double-checked-locking` to `singleton` note, which oversells the idiom;
  - a sourcing pass for the rules of thumb dropped as "needs a source": the fork-join cutoff
    and pieces-per-core ratio, the barrier chunk count, the proactor in-flight cap, a
    channel handover cost, a spinlock threshold;
  - `kb.mjs explain` drops the period after a cost's bold lead when the lead is passed
    without one; the writer could add it, as the page shape expects.
- From the kb-improve run on the ten remaining Resilience patterns (its pull request lists
  every dropped finding):
  - a decide row in `observability` that routes "which hop of one request took the time"
    to `distributed-tracing`; today the row reaches only `correlation-identifier`;
  - a retitle of `design-rate-limiter`, whose title matches the `rate-limiter` pattern's
    and reads as a self-reference in its relationships;
  - a sourcing pass for lines dropped as "needs a source": starting tail-sampling and
    queue sizes (`distributed-tracing`), named fault tools and a stateful-fault con
    (`fault-injection`), an idempotency-key rule and alert thresholds (`hedged-request`),
    signal thresholds and a cost-weighted variation (`leaky-bucket`), a shed-rate alert
    window (`load-shedding`), retention and map-size caps (`request-coalescing`), a pool
    fill-time bound (`timeout-deadline`), a fill-level alert (`token-bucket`);
  - edges drafted but over the cap: `distributed-tracing` to `secure-logger`,
    `hedged-request` to `load-shedding` (alternative-to) and `circuit-breaker`; a
    `hedged-request` to `metastable-failure` note that says "prevents" while the text says
    it only avoids adding load; and the leaky-bucket edge on `rate-limiter`, typed
    combines-with where `token-bucket` is has-variant;
  - variations a senior reader expects, held back by the cap: parent-based sampling and
    clock-skew and tail-sampling cons (`distributed-tracing`), hedge-on-fast-error and a
    stale-replica con (`hedged-request`), a partitioned queue (`load-leveling`),
    server-side deadline enforcement (`timeout-deadline`), the sum of per-key capacities
    as the real burst (`token-bucket`);
  - a second pass for the plan lines dropped as over the cap of 8, mostly wording,
    em-dash and one-claim-per-item splits.
- From the kb-improve run over the 15 Advanced case-study pages (its pull request lists
  every dropped finding):
  - a sourcing pass for the 51 findings dropped as "needs a source": TTLs, thresholds,
    retry caps, error codes, shard counts and lease timings readers asked for in the
    deep dives and interfaces;
  - a second pass for the 99 findings dropped as over the cap of 8;
  - two owner design calls the pages leave open: how `robinhood`'s trade processor
    handles a fill that lands before the order's id is indexed, and whether a `FAILED`
    run ends a `job-scheduler` recurrence;
  - edges drafted but over the cap: `online-chess` demonstrates `websocket` and
    `long-polling`, `ticketmaster` demonstrates `conditional-write`, `leetcode`
    demonstrates `async-request-reply` and `web-queue-worker`, `youtube` exposed-to
    `hot-partition`;
  - the `saga` edge notes on both persona-identification pages still say "failure
    terminals", and the `alternative-to` note between the two pages does not say what
    this side argues; each is an unlink then link;
  - an owner call on `video-recommendations`, a theme page filed in the Advanced
    case-study area: move it with kb-move or keep it there.
- Make the graph page agnostic and useful: `map/graph.html` on the built site, drawn by
  `site/src/components/GraphExplorer/`.

- Tags, parked by the owner on 2026-09-29: add a 3+-pages-per-tag rule to the tags gate (the
  retired `audit-vocab` script only warned); decide whether a practice/process topic earns
  architecture-documentation and its kin; an editorial pass adding honest skills to the 88
  pages with two tags; F9, filing `distributed-monolith` under the anti-pattern topic (it holds
  five tags, the ceiling, so one goes).
- From the 2026-09-30 docs sweep, each needing an owner call:
  - Ban `terminal` through a `house` term's `avoid` list in `docs/data/glossary.json`; about
    100 lines in `CLAUDE.md`, `docs/` and `.claude/rules` use it today, so the ban comes with
    their rewrite. The trap inbox holds the entry until then.
  - The route gate's `WRITES` list (`tools/src/gates/check-harness-routes.ts`) has no `mkdir`,
    so `Bash(mkdir -p tmp/designs/)` in `.claude/settings.json` passes as a read. Add `mkdir`
    and keep that entry as a named exception, or drop the entry.
  - json-sanity prints V8's parse message for `not json` across two stderr lines: collapse
    whitespace in `tidy` (`tools/src/gates/check-json.ts`), as `tools/src/lib/data-json.ts` does.

- From the 2026-10-01 site evaluation,
  round 3 closed every item but one:
  - **Sketch languages.** 96% of pattern sketches are TypeScript; the concurrency patterns
    (semaphore, lock-free, rw-lock, thread-pool) would read more truly in Go, Java or Rust.

- Slim the hub rows' toggles: each row's favourite and practiced buttons inline their own
  SVG icon, 57,000 of `hazards.html`'s 139,078 bytes. One `<symbol>` per page and a
  `<use href>` per button would save about 35,000 a hub (`site/src/components/Favourites/`,
  `Practiced/`); `hubRaw` was re-measured to 149,000 on 2026-10-02 instead.

- Left open when the migration plan was deleted (its history is in git):
  - The CLI's inflected top-1 measures exactly its 98.5% floor; its five misses are not ties.
  - `pages.yml` has not been dispatched by hand, as workflow-edits.md asks.
  - The search box does not show a page's requires and related.
  - `kb.mjs link`/`unlink` could run gen-relations and gen-prerequisites directly instead of
    printing `make gen`.
  - Site-lane owner questions never recorded as settled: `kb:alias` / `kb:solves` head meta
    (head-C1: keep, or move to the manifest and payload); hub controls inside the knowledge
    region (blocks-C9); the search-synonyms third payload key (search-C1) and a Term
    component; home-page atlas controls; about five CORS console errors per page from
    `file://`.

- From the 2026-10-08 retrieval probe of the case studies (`KB_RELEVANCE=report` on
  `tools/src/kb/relevance.test.ts` prints the lists): the first five `find` hits of a case
  study's own problem, each non-functional requirement and `solves` phrase taken together,
  reach 40% of the patterns it demonstrates, and `brief` reaches 83%. Under those numbers:
  - 41 of the 444 demonstrated patterns are not in the first 50 hits of any query of their
    case study's own problem, so the problem as written never finds them:
    `design-distributed-cache` (kiss); `elevator` (value-object, yagni); `connect-four`
    (yagni); `amazon-locker` (valet-key); `design-rate-limiter` (interface-segregation, yagni,
    immutability); `logging-service` (dependency-inversion); `instagram` (competing-consumers);
    `google-news` (object-storage, api-gateway); `yelp` (api-gateway, kiss); `gopuff`
    (retry-backoff); `fb-live-comments` (idempotency); `dropbox` (pubsub); `camelcamelcamel`
    (separation-of-concerns); `bookmyshow` (state); `uber` (consistent-hashing); `tinder`
    (api-gateway); `online-chess` (write-ahead-log, event-sourcing); `youtube`
    (workflow-orchestration); `ticketmaster` (api-gateway); `online-auction`
    (producer-consumer); `robinhood` (separation-of-concerns, sweeper);
    `persona-identification` (priority-queue, external-configuration-store, claim-check, kiss,
    backpressure, distributed-cache, thread-pool); `persona-identification-v2` (object-storage,
    acl, external-configuration-store, claim-check, kiss, batching). `api-gateway` (four case
    studies), `kiss` (four) and `yagni` (three) repeat, so start there. Each wants a `solves`
    phrase or a synonym that says the symptom, or an owner call that a principle like `kiss`
    is reached from the case study and not by symptom;
  - 22 case studies have no case in `docs/data/search-oracle.json`, because their problem in a
    person's words reaches at most one of their patterns in the first eight hits. None:
    `web-crawler`, `google-docs`, `leetcode`, `online-auction`, `camelcamelcamel`,
    `parking-lot`, `logging-service`, `amazon-locker`. One: `bitly` (`cache-aside` at 6; "short
    codes that redirect in milliseconds for billions of reads a day" reaches none),
    `metrics-monitoring`, `ad-click-aggregator`, `fb-post-search`, `gopuff`, `strava`, `uber`,
    `online-chess`, `chatgpt`, `robinhood`, `instagram`, `dropbox`, `elevator`,
    `inventory-management`. `fb-live-comments` reaches two, the second at rank 8 of 8.

## Pages

- Left from the 2026-10-01 evaluation's thin pages: `cache-stampede`, `bot-detection` and
  `harmful-content` sit in the bottom 5% of their blocks; `transaction-script` has no
  real-world entry, because nothing could be named with certainty.
- 21 pages have no inbound prose link, and no page's hand-written prose names them, so a link
  would be forced: each needs a sentence that earns it, written where the idea belongs. Mostly
  principles (`command-query-separation`, `defense-in-depth`, `hyrums-law`, `rule-of-three`,
  …), hazards (`static-cling`, `partial-object`, `priority-inversion`, …) and five
  capabilities (`messaging`, `networking`, `regions`, `resources`, `storage`).
- Left from the 2026-10-04 kb-improve run over `enterprise` (edits a page groom may not make):
  `enterprise-application-patterns` decide rows for Query Object ("search screens glue
  optional filters into SQL strings") and, in `api-design`, for Front Controller ("one entry
  point inside a single web app"); `query-object` has no `production` block and
  `front-controller` has none either, so a reader finds no knobs, signals or failure modes;
  edge notes to re-type or reword by unlink+link: `service-layer` prevents-hazard
  `busy-database` (note overstates), `service-layer` alternative-to `domain-service` (readers
  say combines-with), `service-layer` exposed-to notes, `transaction-script` combines-with
  `active-record` note; `service-layer` fluency label in `learning-paths.json`; `gateway`
  owes two cons (a remote call looks local; the fake drifts from the vendor); `data-mapper`
  owes inheritance-mapping and lazy-loading variations with a source; `dto` spelling
  behaviour/behavior needs a house form.
- Left from the 2026-10-04 kb-improve run over `architecture` (edits to other pages, which a
  page groom may not make): theme `decide` rows to re-check against the pages' `usage` —
  `architecture-styles` Layered ("separated at the network boundary" is not what the page
  says), Event-Driven, a missing Event Sourcing row, Microservices against Modular Monolith;
  `streaming` has no Pipes and Filters row; `frontend-architecture` MVVM and MVP/MVC rows
  need a discriminator; `harness-engineering` has no AI Agent row. Also `big-data`: the
  streaming theme tie-in and the `workflow-orchestration` edge note; `wild` entries to
  source-check: Hystrix and Ribbon status on `microservices`, VS Code Extension Host on
  `microkernel`. Wording first in line: `big-compute` production-failure-2 ("costs as much as
  the first half") and its filler words in structure, variations-item-4 and the description.
- Left from the 2026-10-04 kb-improve run over `frontend` (edits a page groom may not make,
  or that need a source): a hooks / custom-hook pattern page, so `render-props`,
  `container-presentational` and the `frontend-architecture` decide row "Render props / hooks"
  have a target for "use a hook instead"; edges the architects proposed with both notes
  written but over the cap: `micro-frontends` combines-with `microservices`, exposed-to
  `distributed-monolith`, combines-with `conways-law` and `vertical-slice`; `flux`
  combines-with `immutability` (and memento as the snapshot route); `provider` prevents-hazard
  `static-cling`; `atomic-design` combines-with `rule-of-three`; `container-presentational`
  combines-with `decorator` for the HOC form; edge notes to reword by unlink+link:
  `micro-frontends` / `api-gateway` (shell assembles, gateway fronts services), `flux` /
  `lens-optics`, `atomic-design` / `composition-over-inheritance`, `container-presentational`
  / `render-props` (name the hook), and the `render-props` / `strategy` verb (readers say
  variant-of); `flux` prose link to `dry` is untyped. Needs a source before writing: a
  Server Components variation on `container-presentational`; Vue `provide` of a plain value
  not being reactive, and a store-backed provider variation, on `provider`; the React
  Compiler clause and a hooks-inside-the-callback con on `render-props`, and its Downshift
  `wild` entry to source-check; a scoped useReducer/Elm-style loop variation and a
  selector/re-render con on `flux`; a link-based-navigation variation and the slow-fragment
  cost on `micro-frontends` variations-item-4. Data edits: `atomic-design` fluency label in
  `learning-paths.json` should carry the routing condition; its `solves` should catch
  "rebrand means editing dozens of files", which routes to `shotgun-surgery` first today.
- Left from the 2026-10-06 kb-improve run over `distributed-coordination` (edges and blocks
  over the cap, or that need a source): edges with both notes drafted:
  `workflow-orchestration` alternative-to `message-queue`, `sweeper` combines-with `lease`,
  `distributed-lock` combines-with `heartbeat`, `container-orchestration` combines-with
  `rolling-deployment`, `containerization` combines-with `quarantine`, `a2a` combines-with
  `agent-sandboxing`, `federated-identity` alternative-to `valet-key`,
  `optimistic-concurrency-control` exposed-to `retry-storm`, `saga` combines-with
  `retry-backoff`; edge notes to reword by unlink+link: `workflow-orchestration` / `ai-agent`
  ("whenever"), `external-configuration-store` / `persona-identification` ("last cached
  version"), `pessimistic-locking` / `lease` and / `two-phase-commit`; theme row:
  `long-running-tasks` has no Sweeper decide row. Blocks: presumed-commit and read-only
  variations on `two-phase-commit`, read-repair on `quorum-consensus`, interval tree clocks
  on `vector-clock`, the Raft leader heartbeat and a jitter knob on `heartbeat`, a
  replication con on `conditional-write`, an engine-validated variation on
  `optimistic-concurrency-control`, child workflows on `workflow-orchestration`, a hardened
  runtime variation on `containerization`, a grantor-restart step on `lease`. Wording first
  in line: `external-configuration-store` wild (Consul "widely used", etcd is Kubernetes'
  state store). Needs a source: starting values for most `production` knobs and alert
  thresholds the readers asked for across the area (lease term, lock TTL, refresh interval,
  task timeout, probe periods, sweep interval).
- Left from the 2026-10-06 kb-improve run over `distributed-data` (edits a page groom may not
  make, or that need a source): theme `decide` rows — `scaling-reads` has no Inverted Index
  row for keyword search, `spike-handling` no Sliding Window row for the boundary-burst case,
  `proximity-search` no Trie row for typeahead, and the `inbox` rows in
  `consistency-and-replication` and `multi-step-processes` to re-check; edges with both notes
  drafted but over the cap: `inbox` and `outbox` combines-with `change-data-capture`,
  `outbox` combines-with `write-ahead-log`, `replication` combines-with `leader-election`
  and `change-data-capture`, `merkle-tree` alternative-to `change-data-capture`,
  `crdt` exposed-to `clock-skew`, `unique-id-generation` combines-with `lease` and
  exposed-to `hot-partition`, `inverted-index` exposed-to `dual-write-inconsistency` and
  often-confused-with `index-table`, `index-table` to `inverted-index`, `count-min-sketch`
  implemented-by `databases`; edge notes to reword by unlink+link: "an log-structured" and
  "an log" typos in `relations.json` (`write-ahead-log`, `lsm-tree` to `metrics-monitoring`,
  `tinder`, `databases`), the camelcamelcamel note on `change-data-capture`, the Outbox
  "database (DB)'s" note, `materialized-view` notes to `cache-aside`, `n-plus-1` and `cqrs`;
  facts that need a source: Postgres `full_page_writes` on `write-ahead-log`, the Redis
  `hll-sparse-max-bytes` default on `hyperloglog`, a sharded-search local-statistics caveat
  on `inverted-index`, the restart high-water-mark con on `unique-id-generation`, an FST
  variation on `trie`, a third `inbox` sketch for the deferred mode.

- Left from the 2026-10-06 kb-improve run over `distributed-scale` (edits a page groom may
  not make, or that need a source): a `performance` theme decide row routing to
  `vertical-partitioning` and a `scalability` row routing to `functional-partitioning`; a
  `rendezvous-hashing` page and a hazard page for stale ring membership; a Maglev hashing
  variation and the Cassandra `num_tokens` default on `consistent-hashing`, both needing a
  source. Candidate edges to judge on their own: `consistent-hashing`→`sticky-session`,
  `sharding`→`scatter-gather`, `object-storage`→`immutability`,
  `vertical-partitioning`→`sweeper`, `load-balancer`→`failover`, `cdn` often-confused-with
  `reverse-proxy`, `stateless-service`→`distributed-cache`, and `deployment-stamp` to
  `sharding` and `autoscaling`.

- Left from the 2026-10-06 kb-improve run over `concurrency` (pages not reached, edits a
  page groom may not make, or that need a source): nine pages were not groomed —
  `copy-on-write`, `mutex`, `proactor`, `active-object`, `channels`, `ring-buffer`,
  `barrier`, `fork-join`, `double-checked-locking`. `batching` tradeoffs-con-1 uses a colon
  after its bold lead where its neighbours use a dash. A `concurrency` theme decide row for
  code that must not wait (`lock-free` usage-when-2). Needing a source: starting values for
  `scheduling` tick and alert thresholds, the LL/SC caveat on `lock-free` fetch-and-add, a
  striped-counter variation (Java `LongAdder`) on `lock-free`. Candidate edges to judge on
  their own: `lock-free` prevents-hazard `race-condition`, `scheduling` combines-with
  `workflow-orchestration` and alternative-to `sweeper`, a rewritten `scheduling`→`starvation`
  note, `batching` exposed-to `poison-message` and combines-with `dead-letter-channel` and
  `idempotency`.

## Questions

Each may be a page gap. The ids after each question are the top `kb.mjs find` hits, the
place to start before writing anything new.

- How do you scale a queue across topics and partitions, and keep it durable?
  (scaling-writes, long-running-tasks, job-scheduler)
- What is the difference between a worker and a consumer? (competing-consumers,
  load-leveling, message-queue)
- What stops a poison message from looping through redelivery in a fan-out? (fan-out,
  message-queue, dead-letter-channel)
- What do you do about publish-burst amplification? (fan-out, recipient-list)
- How do you apply backpressure? (backpressure, unbounded-queue, streaming)
- What is a relay? (messaging-bridge, outbox, dual-write-inconsistency)
- How do you resolve or prevent a race condition, and make a read-then-write atomic?
  (conditional-write, race-condition, copy-on-write)
