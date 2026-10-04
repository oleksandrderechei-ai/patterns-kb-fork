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
