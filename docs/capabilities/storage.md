---
title: Storage
description: "Object, block, file and archive — what each is for, and what every cloud calls it"
area: capabilities
owner: Oleksandr Derechei
tags: [persistence, durability, data-access, cloud]
status: stable
aliases: [cloud storage, blob storage]
solves: [I do not know whether to put these uploads in the database or somewhere else, "our storage bill is mostly egress and requests, not gigabytes", I know the AWS storage service but not what it is called on Azure or Google Cloud, we moved to archive storage and it got more expensive, my API is streaming large file uploads through the application server]
---

# Storage

Four shapes of managed storage — object, block, file and archive — what each one is actually for, what every cloud calls it, and which of them come with the patterns already built.

## What the cloud gives you here
<!--meta block=description-->

Every cloud sells four shapes of storage, and the shape you pick decides the API you write against for the life of the system. [Object storage](../patterns/distributed/routing/object-storage.md) is whole blobs by key over HTTP, block is a raw device one machine mounts, file is a directory tree many machines mount, and archive is object storage priced for data you almost never read. Redundancy scope and access control do not map mechanically.
## Explained
<!--meta block=explain-->

Cloud storage comes in four shapes. Object storage holds whole blobs addressed by key over HTTP. Block storage is a raw disk that one machine mounts. File storage is a directory tree many machines mount at once. Archive is object storage priced for data you almost never read. Pick on two questions: who writes, and how far apart must the copies be. One writer that updates the middle of a file forces block, and many machines that need a filesystem force shared file. Everything else should be object, the only shape that grows without a resize.

- **Request and egress fees dominate the bill** Write fewer, larger objects and put a cache in front of anything user-facing.
- **Cold tiers charge to read** A retrieval fee and a minimum storage time mean demoting data you later re-read costs more than never tiering.
- **Redundancy names mislead** A second-region copy is sometimes readable at once and sometimes only after failover, so map by what you can read.

**Example.** You store 1 million objects of 4 KB each, 4 GB in all. Use illustrative prices: 0.005 dollars per 1,000 write requests and 0.023 dollars per GB-month. Writing them costs 1,000 times 0.005, or 5 dollars, while a month of storage costs about 0.09. Packing them into 1,000 files of 4 MB makes 1,000 writes, or 0.005 dollars. The cost is that reading one small record now means fetching a byte range of a larger file, so you keep an index of where each record sits.

## The capabilities
<!--meta block=capabilities-->

- **[Object storage](../patterns/distributed/routing/object-storage.md)** — A flat keyspace of whole blobs behind an HTTP API, with no partial writes and no real directories. Reach for it by default for anything a user uploaded, anything a batch job emitted, and anything a database row wants to point at instead of hold.
- **Block storage** — A raw virtual disk attached to exactly one machine, which formats it and mounts a filesystem on it. This is what a self-managed database sits on, and the only shape that gives you a real block device with the IOPS (input/output operations per second) and throughput you provisioned.
- **Ephemeral local disk** — Storage physically attached to the host your instance runs on. It is the fastest thing available and it does not survive the instance being stopped or moved, so it holds scratch space, spill files and caches — never the only copy of anything.
- **Shared file storage** — One directory tree that many machines mount at the same time, with the file semantics an unmodified application already expects. Reach for it when you are lifting software you cannot rewrite; write new software against object storage instead.
- **Parallel file system** — Shared file storage that stripes each file across many servers, for jobs where hundreds of readers hit one dataset at once. It is the storage tier for training runs and HPC, and it is priced accordingly.
- **Access tiers** — The same object, priced along a curve from instantly readable to hours-to-restore. Each step down cuts the resting price and adds both a retrieval fee and retrieval latency, so a tier is only cheaper if your guess about future reads was right.
- **Lifecycle rules** — A policy that moves or deletes objects on age or key prefix with nothing of yours running. This is what makes tiering real: without it everything stays hot, because nobody remembers to demote it.
- **[Delegated access](../patterns/distributed/routing/valet-key.md)** — A signed, time-limited URL that lets a client read or write one object directly, with no credentials of its own and without the bytes passing through your service. It is the difference between your API streaming a 2 GB upload and your API handing out a link.
- **Redundancy scope** — How far apart the copies are: one building, several buildings in one metro, or two regions. It is the most consequential storage setting you will pick, and the one whose vocabulary differs most between providers.
- **Bulk transfer** — Getting a large existing dataset in, either over the network on a managed schedule or on a physical appliance the provider ships you. Past roughly a hundred terabytes the appliance beats any link you can rent in time to first byte.
- **Managed backup** — Policy-driven point-in-time copies across many resource types, with retention and restore handled for you. Replication is not backup — it copies your mistake to the other region at the speed of light.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Object storage | Amazon S3 | Azure Blob Storage | Cloud Storage | Ceph, [MinIO](../comparisons/object-stores.md) (community repository archived in 2026, no longer maintained) |
| Block storage, one virtual machine (VM) | Amazon EBS | Azure managed disks | Persistent Disk, Hyperdisk | Ceph RBD |
| Ephemeral local disk | EC2 instance store | VM temporary disk | Local SSD | no direct open-source equivalent |
| Shared file storage, Network File System (NFS) | Amazon EFS | Azure Files | Filestore | Linux NFS server |
| Shared file storage, SMB | FSx for Windows File Server | Azure Files | Google Cloud NetApp Volumes | Samba |
| Parallel file system | FSx for Lustre | Azure Managed Lustre | Google Cloud Managed Lustre | Lustre |
| Infrequent-access tier | S3 Standard-IA | Blob cool tier | Nearline | no direct open-source equivalent |
| Cold tier | S3 Glacier Instant Retrieval | Blob cold tier | Coldline | no direct open-source equivalent |
| Archive tier | S3 Glacier Deep Archive | Blob archive tier | Archive | no direct open-source equivalent |
| Lifecycle rules | S3 Lifecycle | Blob lifecycle management | Object Lifecycle Management | MinIO lifecycle rules |
| Delegated access URL | pre-signed URL | shared access signature | signed URL | MinIO presigned URLs |
| Cross-region object copies | S3 Cross-Region Replication | object replication; GRS and GZRS | dual-region and multi-region buckets | rclone |
| Offline transfer appliance | AWS Snowball | Azure Data Box | Transfer Appliance | no direct open-source equivalent |
| Online bulk transfer | AWS DataSync | Azure Storage Mover | Storage Transfer Service | rclone |
| Managed backup | AWS Backup | Azure Backup | Backup and DR Service | Restic, BorgBackup |
| Malware scanning of uploaded objects | Amazon GuardDuty Malware Protection for S3 | Microsoft Defender for Storage malware scanning | no first-party equivalent | ClamAV |

## Choosing between them
<!--meta block=choosing-->

Start from object storage and justify anything else. It is the cheapest per gigabyte, the only shape that scales without you resizing it, and the only one several services can read at once without a filesystem in the way. The two questions that move you off it are whether a single process needs to write into the middle of a file, and whether the software doing the writing is software you are allowed to change.

| If you need… | Choose | Because |
| --- | --- | --- |
| Somewhere to put uploads, exports, backups, logs | Object storage | Cheapest, unbounded, and readable straight from a browser with a signed URL |
| A disk under a database you run yourself | Block storage | Only shape offering a real block device with provisioned IOPS and durability |
| Scratch space for a shuffle or a spill file | Ephemeral local disk | Fastest available, and losing it on restart costs you nothing |
| Legacy software that must see a POSIX path | Shared file storage | Buys you the lift without a rewrite — pay for it deliberately, not by default |
| Many readers hammering one training dataset | Parallel file system | Stripes a single file across servers so aggregate read throughput scales |
| Bytes served to users worldwide | Object storage plus a [content delivery network (CDN)](../patterns/distributed/routing/cdn.md) | Origin egress is the bill; edge caching is what removes it |
| Seven-year retention nobody will ever read | Archive tier plus lifecycle rules | Resting price falls by an order of magnitude; the retrieval fee never comes due |

Tiering deserves its own decision, because the failure mode is quiet. Objects demoted to a cold or archive tier carry a minimum storage duration, and deleting or re-reading them early is billed as though you had kept them the full term. A lifecycle rule that demotes at 30 days on a dataset that is genuinely re-read at 45 costs more than never tiering at all, and nothing in the bill will tell you that is what happened.

The bill for storage is rarely storage. Request charges dominate small-object workloads — a million 4 KB objects cost far more in PUT and GET requests than in bytes at rest — and egress dominates anything user-facing. Both have the same counter-move: put fewer, larger objects behind a cache. Pack small files into columnar or archive formats before writing them, and put a [CDN](../patterns/distributed/routing/cdn.md) in front of anything read more than once.

## What does not port
<!--meta block=portability-->

- **Redundancy scope hides behind similar words**: one provider's default keeps every copy in a single building, another's spreads them across buildings in one metro. Read the specific setting rather than the marketing line, because the difference is exactly the failure you bought the storage to survive.
- **A cross-region copy is not always a readable copy**: some cross-region replication modes give you a second-region copy you can read at any time, and others give you one that only becomes accessible after a failover is declared. A disaster-recovery plan that assumes the first and gets the second does not work on the day it matters.
- **Delegated-access URLs differ in lifetime and revocation**: maximum validity, what the signature covers, and whether you can revoke a URL you already handed out all vary. Plan for the shortest lifetime any of your targets allows, and never treat a signed URL as revocable unless you have checked that it is.
- **Access control is one layer on one cloud and two on another**: on some, the identity policy and the object policy together decide everything; on others a separate network firewall sits in front of both and can deny a request the identity policy allowed. Porting the policies is not porting the access model — enumerate the deny paths, not just the allow ones.
- **Not every disk type can boot**: the highest-performance block volume classes are frequently data-only, so a machine image that assumed one volume type may need a second, slower volume just to start. Check this before sizing, not after.
- **Tier names do not line up**: "cold" is a distinct tier on one provider and a synonym for archive on another, and retrieval latency at the same nominal tier ranges from milliseconds to hours. Map on retrieval time and minimum duration, never on the tier's name.
- **Egress pricing is the real lock-in**: storing a petabyte is affordable on every cloud and moving it out is not, so the cost of leaving grows with the data you accumulate. If portability matters, keep the authoritative copy in an open format with a lifecycle rule that expires what you no longer need.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [CDN](../patterns/distributed/routing/cdn.md) — Object storage holds the origin copy; the content delivery network (CDN) is what stops you paying origin egress for every read.

**Generalizes**

- [Object stores](../comparisons/object-stores.md) — The object-tier product decision, argued store by store.

**Implements**

- [Object Storage](../patterns/distributed/routing/object-storage.md) — Every cloud's object store is this pattern sold as a service — buckets, keys and a reference in your database.
- [Valet Key](../patterns/distributed/routing/valet-key.md) — Signed, time-limited URLs are the built-in valet key — the client reads or writes the object directly.
- [Replication](../patterns/distributed/coordination/replication.md) — Redundancy scope is replication as a setting: one building, one metro, or a second region.
- [Claim Check](../patterns/messaging/claim-check.md) — The store that holds the large payload while the message carries only its key.
- [Quarantine](../patterns/security/quarantine.md) — Malware scanning tags or moves an uploaded object before anything trusts it.

<!-- relationships:end -->
