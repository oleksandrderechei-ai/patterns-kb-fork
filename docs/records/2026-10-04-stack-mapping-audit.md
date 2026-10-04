# Stack mapping audit

On 2026-10-04 the pattern-to-product index (`map/stack.html`) was checked against vendor
documentation, and its gaps were filled or explained. Nine agents audited the capability
pages (regions and resources together) and a tenth the comparison matrices. Each searched
vendor docs on the web and returned findings only; the main session judged each one and made
the edits. This record keeps the counts, what changed and what is still open. The numbers are
true on its date.

## Counts

| | Before | After |
| --- | --- | --- |
| Rows in the index | 261 | 260 |
| Patterns a cloud sells (an `implements` edge from a capability) | 93 | 110 |
| Patterns no cloud sells, by nature (`docs/data/stack.json`) | 0 per pattern, 5 bands | 142, across 6 band notes and 85 reasons |
| Patterns with no mapping and no reason | 103 dashed with no verdict, plus 59 in unbuyable bands | 3 |
| Pinned table rows (`maps_*` with `maps_label_*`) | 112 | 134 |

## What changed in the machinery

- **Label pins.** A row id is its position, so a row inserted above a pin moved the pin onto
  another row and no gate noticed. Every `maps_*` now carries `maps_label_*`, the row's first
  cell, and the relations gate fails a pin whose row no longer reads it. The failure names the
  row the label has moved to. `kb.mjs link --maps <row-id>` writes both keys.
- **Verdicts in data.** The band notes left `tools/src/lib/site-map.ts` for
  `docs/data/stack.json`, which also holds one reason per pattern no cloud sells. Those rows
  render in a `none` state with the reason under the pattern's name. The build refuses a
  reason that an `implements` edge contradicts.

## Cells corrected

- **Networking, service mesh, AWS**: "AWS App Mesh retired on 30 September 2026; Amazon VPC
  Lattice, ECS Service Connect". The old cell denied a mesh and then named two.
  <https://docs.aws.amazon.com/app-mesh/latest/userguide/concepts.html>
- **Networking, service discovery, Azure**: there is no registry service, but Azure Container
  Apps resolves apps by name. "No first-party equivalent" overstated the gap.
  <https://learn.microsoft.com/azure/container-apps/connect-apps>
- **Observability, fault injection, Google Cloud**: Fault Injection Testing entered Preview
  in June 2026.
  <https://cloud.google.com/blog/products/networking/introducing-google-cloud-fault-injection-testing-in-preview>
- **Observability, synthetic checks, Azure**: the classic URL ping tests retired on
  2026-09-30, so the cell now names Application Insights standard availability tests.
  <https://learn.microsoft.com/azure/azure-monitor/app/availability-overview>
- **Storage, SMB file storage, Google Cloud**: Google Cloud NetApp Volumes, not "none".
  <https://cloud.google.com/netapp-volumes>
- **Storage, parallel file system, Google Cloud**: Google Cloud Managed Lustre replaces
  Parallelstore. <https://blocksandfiles.com/2025/04/09/google-cloud-offering-managed-lustre-service-with-ddn/>
- **Storage and data analytics, MinIO**: the community repository is archived and no longer
  maintained. "Maintenance mode" understated it. <https://vonng.com/en/db/minio-resurrect/>
- **Messaging, point-to-point queue, Google Cloud**: the cell now says "Pub/Sub with one pull
  subscription" first. Cloud Tasks pushes over HTTP and has no pull API.
  <https://cloud.google.com/tasks/docs/comp-pub-sub>
- **Messaging, delayed delivery, open source**: ActiveMQ Artemis has scheduled messages.
  <https://artemis.apache.org/components/artemis/documentation/latest/scheduled-messages.html>
- **Messaging, event store, open source**: KurrentDB is source-available, not open source.
  <https://docs.kurrent.io/latest>
- **Databases, change stream, Google Cloud**: Spanner and Bigtable change streams, not
  Firestore triggers. <https://cloud.google.com/spanner/docs/change-streams>
- **Databases, approximate count, Azure**: `hll()` and `dcount_hll()` are the sketch
  functions. <https://learn.microsoft.com/azure/data-explorer/kusto/query/dcount-hll-function>
- **Databases, in-memory cache, Azure**: Azure Cache for Redis retires in September 2028.
- **Identity, short-lived credentials, Azure**: "Microsoft Entra ID access tokens". There is
  no product called the Entra token service.
- **Identity, just-in-time elevation, AWS**: "no first-party managed service". AWS documents
  the pattern and ships a sample, but sells no service.
  <https://docs.aws.amazon.com/singlesignon/latest/userguide/temporary-elevated-access.html>
- **Resources, landing zones, Google Cloud**: the enterprise foundations blueprint is a
  first-party reference, as Azure landing zones are. <https://cloud.google.com/architecture/landing-zones>
- **Compute, open source**: OpenStack flavors for instance sizing, and OpenStack Heat
  autoscaling groups for the VM autoscaling row.
- **Comparisons**:
  - MariaDB is managed on Amazon RDS only, since Azure Database for MariaDB retired in
    September 2025.
  - MinIO's governance cell now records the archive.
  - Heroku has been in sustaining engineering since February 2026.

## New capability rows

Each row is appended at the end of its table, so no existing pin moved.

| Page | Row | Serves |
| --- | --- | --- |
| compute | Scheduled job trigger | sweeper, scheduling |
| messaging | Schema registry | message encoding |
| storage | Malware scanning of uploaded objects | quarantine |
| data-analytics | Managed agent memory | agent memory |
| data-analytics | Sandboxed code execution for agents | agent sandboxing |
| data-analytics | Managed MCP tool gateway | Model Context Protocol |

Compute, networking, databases, messaging and data-analytics are now past the 12 to 16 rows
the kb-capability-blocks skill asks for. Compute's own auditor named the merges that would
bring it back (blue/green with canary, image with image build). That decision is the owner's.

## Pins moved, dropped or added

- **Moved, because the old row overclaimed**:
  - leader election, to the lock-and-lease row;
  - failover, to DNS failover between regions;
  - polling consumer, to the point-to-point queue;
  - embeddings, to the foundation-model platform;
  - saga on the orchestrator comparison, to "Compensating a half-done run".
- **Dropped, because the row did not sell the pattern**:
  - write-ahead log on the databases page (point-in-time restore is its consequence);
  - valet key on identity (storage's delegated access URL is the real pin);
  - sidecar on observability (moved to the service mesh);
  - materialized view on search engines;
  - workflow orchestration on messaging (compute owns the row).
- **Retyped from `combines-with` to `implements`, with a pin**:
  - sharding (automatically sharded database);
  - gatekeeper (web application firewall);
  - claim check (object storage);
  - correlation identifier (distributed trace collection).
- **New pins on existing rows**:
  - saga, async request-reply and compensating transaction on workflow orchestration;
  - compute resource consolidation on managed Kubernetes;
  - ambassador on the service mesh;
  - strangler fig on the API gateway;
  - geode on the global anycast entry point;
  - multi-tenancy on the billing and permission boundary;
  - inverted index on managed search;
  - A2A on the managed agent runtime;
  - health endpoint on synthetic checks.
- **New comparison pins**: sequential convoy (broker ordering), compensating transaction
  (orchestrator compensation), cache-aside (key-value typical role), replication (relational
  reads at scale) and embeddings (search engines, vector search).

## Left open

- **Request coalescing.** CloudFront, Cloud CDN and Varnish collapse concurrent misses, but no
  Microsoft document says Azure Front Door does. A pin would copy the whole CDN row, Front
  Door included, so it waits for a source.
- **Index table.** DynamoDB global secondary indexes are the managed form, but no Azure or
  Google Cloud equivalent was confirmed.
- **Bloom filter.** ElastiCache for Valkey 8.1 and Azure Managed Redis offer one; Memorystore
  was not confirmed.
- **Weak pins kept.** Token bucket and leaky bucket on edge rate limiting: AWS WAF counts in a
  sliding window and Front Door in a fixed one. Intercepting validator on the web application
  firewall: the pattern is an in-process chain. Replication on cross-region object copies.
- **Unverified for want of access.** The egress proxy blocked some vendor pages, so a few Google
  names rest on search snippets: Memory Bank, Code Execution and the Apigee MCP support. Check
  them when the docs are reachable.
