---
title: Object stores
description: "Six blob stores behind one API — three you rent, three you run"
area: comparisons
owner: Oleksandr Derechei
tags: [persistence, durability, cloud]
status: stable
aliases: [s3, minio, ceph, seaweedfs, blob storage, gcs]
solves: [we need cloud-style file storage but it has to run on our own hardware, I cannot tell whether running our own object storage is cheaper than paying a cloud for it, file uploads are outgrowing the app server disk, a second app server cannot see the files the first one saved, egress fees make it expensive to read our own data back]
---

# Object stores

Amazon Simple Storage Service (S3), Azure Blob Storage and Google Cloud Storage against MinIO, Ceph and SeaweedFS: who operates the disks, which license you inherit, and what it costs to read your data back out.

## What this compares
<!--meta block=description-->

An object store keeps immutable blobs in one flat namespace, addressed by key over HTTP. This page compares three stores you rent from a cloud with three open-source servers you run, on API compatibility, operational load, inherited license and the cost of leaving. On every one, bytes never stream through your service: you issue a time-limited signed URL, the [Valet Key](../patterns/distributed/routing/valet-key.md) pattern, and the client talks to the store directly.
## Explained
<!--meta block=explain-->

An object store keeps whole files, called objects, in one flat namespace, each addressed by a key and reached over HTTP. Your service hands the client a time-limited signed link and the bytes flow straight to the store, never through your servers. In a public cloud, use the cloud's own store: running one yourself on rented machines buys the same disks twice and adds a service to your on-call rotation. Run your own, such as MinIO, when you need the same interface on your own hardware or at the edge and one team can own the cluster. Choose Ceph only when object is one part of a larger private-cloud need and you can staff it. Before any of these, a directory and a table of paths carries one service a long way.

- **The S3 interface is the one most others copy.** Azure has its own, so code that must run on both needs an abstraction layer.
- **Leaving a cloud store is metered by the gigabyte read out.** Keep a copy elsewhere if exit matters.
- **A license such as AGPL reaches into what you distribute.** Read it before you build on the server.

**Example.** You hold 50 TB, which is 50,000 GB, in a cloud store. Illustratively, reading data out costs 0.09 dollars per GB. Moving everything to another provider then costs 50,000 times 0.09, or 4,500 dollars, before you pay the new store at all. If your code speaks the S3 interface, the code change is mostly a new endpoint address. If it uses a provider's own interface, you also rewrite every call. A self-run store has no per-GB exit fee, but its price is the engineer who keeps it running.

## The contenders
<!--meta block=contenders-->

- **Amazon S3** — The store whose API the rest of the field implements, operated by AWS and billed per gigabyte, per request and per gigabyte of egress. Storage classes run from hot down to archive, and a read after a write returns the new object rather than the old one.
- **MinIO** — A single S3-compatible binary you run yourself, erasure-coding across the drives you hand it, licensed AGPLv3. It is the shortest path to an S3 endpoint on your own hardware. In 2025 the community edition's web console lost most of its management features, and its community repository went into maintenance in December 2025 and is no longer maintained.
- **Azure Blob Storage** — Microsoft's object store, operated by Azure, speaking its own API rather than an S3-compatible one. That costs portability: code that must run on both clouds needs an abstraction layer over the two. Access tiers cover hot through archive.
- **Google Cloud Storage** — Google's object store, operated by Google, with an S3-interoperable XML API alongside its native one, so many existing S3 clients can be pointed at it. Multi-region buckets serve one bucket from several regions without you building the replication.
- **Ceph with the RADOS Gateway** — A full distributed storage platform under LGPL, serving block volumes, a POSIX filesystem and S3-compatible objects from one cluster. It backs many private clouds at petabyte scale, and it is heavy to operate: the cost is people, not disks.
- **SeaweedFS** — An Apache-2.0 store built for very large numbers of small files, with an S3-compatible gateway in front of it. It stands up faster than Ceph, and it earns its place when what you outgrew was a filesystem's per-directory and per-inode limits rather than raw capacity.

## How they compare
<!--meta block=matrix-->

| Criterion | Amazon S3 | Azure Blob | Google Cloud Storage | MinIO | Ceph RGW | SeaweedFS |
| --- | --- | --- | --- | --- | --- | --- |
| Speaks the S3 API | Native | No — its own API | S3-interoperable XML API | Yes | Yes, via the gateway | Yes, via the gateway |
| Who operates it | AWS | Microsoft | Google | You | You | You |
| License | Proprietary service | Proprietary service | Proprietary service | AGPLv3 | LGPL | Apache-2.0 |
| Ops burden | Policy and lifecycle only | Policy and lifecycle only | Policy and lifecycle only | One binary to run and patch | A specialist skill set | Moderate; more moving parts than MinIO |
| Typical deployment | AWS regions | Azure regions | Google Cloud regions | On-premises, edge, continuous integration (CI) | Private cloud, research computing | On-premises, small-file archives |
| Durability design | Replication across zones; 11-nines design target | Replication: local, zone or geo-redundant | Replication: regional or multi-region | Erasure coding across your drives | Replicated or erasure-coded pools | Replication configured per volume |
| Read after write | Strong | Strong | Strong | Strong | Strong | Depends on the replication mode |
| Cold tiering | Storage classes down to deep archive | Access tiers down to archive | Storage classes down to archive | Lifecycle transition to a remote tier | Lifecycle rules onto cheaper pools | You place volumes on the disks you choose |
| Cost of reading it all back out | Metered egress per gigabyte | Metered egress per gigabyte | Metered egress per gigabyte | Bandwidth you already pay for | Bandwidth you already pay for | Bandwidth you already pay for |
| Also serves block or file | No — separate services | No — separate services | No — separate services | No — object only | Yes — block volumes and a POSIX filesystem | A filer with a FUSE mount |
| Governance to weigh | Vendor roadmap; closed source, so no fork possible | Vendor roadmap; closed source, so no fork possible | Vendor roadmap; closed source, so no fork possible | AGPL reach; the community repository went into maintenance in December 2025 and is no longer maintained | Foundation-governed, many contributing vendors | Community project with a small core team |

## Choosing between them
<!--meta block=choosing-->

In a public cloud, use the native store. Running your own object store on rented instances buys the same disks twice and adds a service to your on-call rotation.

Choose MinIO when you need the S3 API on-premises or at the edge and one team can own the cluster. Two conditions come with it: check how far AGPLv3 reaches into what you distribute, and plan for a fork or the commercial AIStor build, since the community repository has been in maintenance since December 2025.

Choose Ceph when object is one facet of a larger private-cloud need — the same cluster handing block volumes to virtual machines and a filesystem to a compute grid. It repays a dedicated operations team and punishes a part-time one.

Choose SeaweedFS when the workload is millions of small files and what you outgrew was a filesystem rather than a disk.

Before any of them, do less: a directory and a table of paths carries a single service a long way. Move to an object store when a second service needs the same blobs, or when the disk is what you are trying to scale.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Valet Key](../patterns/distributed/routing/valet-key.md) — Every store here issues signed URLs, so clients upload and download directly and bytes skip your service.

**Specializes**

- [Storage](../capabilities/storage.md) — Zooms in on the object tier of the storage capability and names the products behind it

**Implements**

- [Object Storage](../patterns/distributed/routing/object-storage.md) — Six products that provide this pattern off the shelf — three rented from a cloud, three you run yourself

<!-- relationships:end -->
