---
title: Containerization
description: "Ship the application and its dependencies as one immutable, layered image"
area: distributed-coordination
owner: Oleksandr Derechei
tags: [operations, isolation, lifecycle]
status: stable
aliases: [container image, Docker image, OCI image, immutable infrastructure]
solves: [it works on my machine but not on the server, two services need different runtime versions on the same host, our servers have drifted apart and nobody can say how, every deploy is a list of manual steps on a prepared server and it sometimes stops halfway, our image is two gigabytes and every scale-out waits on the pull]
---

# Containerization

Packages an application together with every library, tool and file it needs into one immutable image built from stacked layers — so the artifact that was tested is bit-for-bit the artifact that runs, and the machine underneath it supplies only a kernel.

## What it is
<!--meta block=description-->

Servers prepared by hand drift apart: a patch here, a pinned library there, a config edited during an incident. Containerization ships the application, its runtime and libraries as one image that never changes after it is built. The host supplies only a kernel and isolation. A change means building a new image and replacing the container, so what you tested is what runs.

## Explained
<!--meta block=explain-->

Containerization packages an application with its runtime and libraries into one image that never changes after it is built, so the thing you tested is the same thing that runs in production. Without it, machines drift apart through hand patches and edited config files until two servers differ in ways nobody can list. An image is a stack of layers, each stored once by content, so forty services sharing a base layer pull it once per host, and a code change rebuilds only the layers above it. Choose it over installing onto prepared machines when you create and destroy instances often or run services with different runtime versions on one host.

- **Inherited vulnerabilities** You own the base image vulnerabilities; scan on build and rebuild when the base updates.
- **Image size** Size is paid on every scale-out; use a small base and a multi-stage build, and debug through logs.
- **Movable tags** A tag can be repointed at new content; reference digests (the content hash).
- **Shared kernel** Containers share one kernel, so a workload needing strong separation needs its own machine.

**Example.** A service image is 800 MB: 700 MB base, 80 MB dependencies, 20 MB code. Ordered base, then dependencies, then code, a code-only commit rebuilds and pushes 20 MB. Ordered wrongly, with code copied before the dependencies are installed, every commit pushes 100 MB. A new host pulling the whole image at 100 MB/s takes 8 s. Switching to a 20 MB minimal base and shipping only the built output shrinks the image to about 120 MB, which pulls in 1.2 s. The price is that you cannot open a shell in the running container, so you debug through logs or attach a temporary debug container.

## How it works
<!--meta block=structure-->

```mermaid caption="Why does layer order decide build cost? A code change invalidates layer 4 and nothing below it, so step 5 pushes one small layer. Put the source copy at layer 2 instead and every code change invalidates the dependency install above it, so each build reinstalls everything and pushes the lot."
flowchart LR
    SRC["Source + dependency manifest"]
    subgraph B["Build — layers, least-changing first"]
        L1["1 base image layer"] --> L2["2 system packages"]
        L2 --> L3["3 dependencies from manifest"]
        L3 --> L4["4 application code"]
    end
    REG[("Image registry")]
    H1["Host A"]
    H2["Host B"]
    SRC -->|"1 build"| L1
    L4 -->|"5 push, by content digest"| REG
    REG -->|"6 pull — shared layers already present"| H1
    REG -->|"6 pull — shared layers already present"| H2
```

## Variations
<!--meta block=variations-->

- **Multi-stage build** — Compile in one stage with the full toolchain, then copy only the produced binary into a clean final stage. The compiler, the build cache and the source never reach the shipped image, which cuts both its size and everything an attacker could use inside it.
- **Minimal or distroless base** — A base carrying the runtime and nothing else: no shell, no package manager. It removes most of the exploitation surface and your ability to open a shell in a misbehaving container, so you debug through logs or ephemeral debug containers instead. It can also run with a read-only root filesystem.
- **Build-tool image construction** — Produce the image from the application's own build system rather than from an imperative build file, so layering follows the dependency graph the tool already knows. Removes a class of hand-written mistakes, at the cost of less control over exactly what lands where.
- **Digest pinning and signing** — Reference images by content digest rather than by a mutable tag, and verify a signature before running. A tag can be repointed at different content by whoever controls the registry; a digest cannot.
- **Promotion of one artifact across environments** — Build once and promote the same digest from test to staging to production, injecting environment differences as configuration at run time. Rebuilding per environment brings the drift back.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **The artifact that was tested** is the artifact that runs, because nothing modifies it between the two.
- **Shared layers are stored and transferred once**, so a fleet of similar services costs far less to distribute than its total size suggests.
- **Rollback is running the previous digest**, with no uninstall step and nothing to undo on the host, provided the new version changed no persistent state; data migrations need their own rollback.
- **A developer's machine runs** the same image as production, so "works here" says more about the image than about the machine, though kernel, CPU architecture and configuration can still differ.

### Cons
<!--meta polarity=con-->

- **You have inherited a base image's entire contents**, including its vulnerabilities, and you now own patching them.
- **Image size is a real cost** — in registry storage, in pull time on every scale-out, and in cold-start latency.
- **A badly ordered build file** rebuilds and re-pushes almost everything on every commit, which is invisible until someone measures it.
- **Secrets baked into a layer** stay in the image even if a later layer deletes them, because layers are diffs and nothing is truly removed.
- **A mutable tag is not an identity**: the same tag can resolve to different content tomorrow, so reproducibility needs digests rather than names.
- **Isolation is a kernel feature, not a boundary**: containers on one host share it, so a kernel vulnerability crosses between them in a way separate machines would not permit.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Deployments differ between environments** in ways nobody can fully account for.
- **Instances are created and destroyed** often enough that preparing each one is a bottleneck.
- **Several services with different runtime** versions have to share hosts without conflicting.

### Avoid when
<!--meta polarity=avoid-->

- **The workload needs strong isolation from its neighbours** — a shared kernel is a weaker boundary than a separate machine.
- **A managed platform already takes** your source and produces the artifact — you have this, without owning a build file.
- **It is one long-lived stateful** service on one machine, where the packaging buys little and adds a build pipeline.

## Code sketch
<!--meta block=sketch-->

```text summary="Plain text — a multi-stage build, ordered so a code change rebuilds one layer"
# ---- stage 1: build, with the whole toolchain available ----
# Production: pin the base by @sha256:<digest>; the tag is shown for readability.
FROM node:22 AS build
WORKDIR /src

# Manifests FIRST, on their own. This layer is only invalidated when a
# dependency actually changes — not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# Source LAST. A code change invalidates only from here down.
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- stage 2: the shipped image, with no compiler and no source ----
# Production: pin the base by @sha256:<digest>; the tag is shown for readability.
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app

# Only the built output crosses the stage boundary; toolchain and .git stay behind.
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist

# never the default privileged account
USER nonroot
EXPOSE 8080
CMD ["dist/server.js"]

# Deliberately NOT here: a token written in a layer (it survives a later delete,
# because layers are diffs; use a build-time mount) and FROM node:latest (a
# mutable tag is not an identity; pin a digest).
```

## In the wild
<!--meta block=wild-->

- **OCI Image Specification** — The vendor-neutral standard defining what an image is: an ordered set of content-addressed layers plus a configuration document, which is why an image built by one tool runs on a runtime written by someone else. {#wild-oci-image-spec}
- **BuildKit** — Builds the layer graph concurrently and caches by content rather than by instruction order, and supports build-time secret mounts so a credential can be used during a build without being written into a layer. {#wild-buildkit}
- **Distroless base images** — Base images carrying a language runtime and its dependencies with no shell and no package manager, which removes most of what a compromised process could execute. {#wild-distroless}
- **Trivy** — Scans a built image layer by layer against vulnerability databases, which is how an inherited base-image CVE becomes visible before the image ships rather than after. {#wild-trivy}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Layer order in the build file** — Which instructions sit above which. Determines what a code change invalidates, and therefore build time and push size on every commit.
- **Base image choice** — Full distribution, slim variant, or minimal with no shell. Trades image size and attack surface against how much you can do inside a running container.
- **Reference style: tag or digest** — Whether deployments name a mutable tag or an immutable content digest. Digests make a deployment reproducible; tags make it convenient.
- **Build-time secret handling** — Whether credentials arrive as build arguments, environment variables or a mount. Only the mount keeps them out of the resulting layers.

### Signals to watch
<!--meta polarity=signal-->

- **Image size and pull time** — Compressed size and the time a host spends pulling it. Paid on every scale-out and every cold start, so it shows up as latency rather than as a build metric. Set the budget as scale-out latency target minus node start time, multiplied by the pull bandwidth measured on a cold host.
- **Build cache hit rate** — How many layers are reused per build. A sudden drop is usually a build file edit that moved something above the dependency install. Record the median hit rate over a week and alert when a build with no dependency change falls below it.
- **Base image age and known vulnerabilities** — How long since the base was refreshed, and what a scan reports. Rises on its own with no change from you, which is what makes it easy to miss.
- **Digest drift per environment** — Whether the digest running in production is the digest that passed testing. Any difference means something was rebuilt rather than promoted.

### Failure modes under load
<!--meta polarity=failure-->

- **Every build ships the whole image** — A source copy placed above the dependency install invalidates it on each commit, so builds slow and registry egress grows while nothing about the application changed.
- **Pull time dominates scale-out** — A large image on a host with a cold cache means new capacity arrives minutes after it was asked for, which turns an autoscaling response into an outage extension.
- **A secret is recoverable from the image** — A credential written in one layer and deleted in a later one is still present in the earlier layer, and anyone who can pull the image can extract it.
- **The tag moved underneath you** — A deployment referencing a mutable tag picks up different content than the one that was tested, so two identical-looking deployments run different code.

### Readiness checklist
<!--meta polarity=check-->

- Build order puts the least-changing layers lowest, and the effect is measured as build time and push size rather than assumed.
- The shipped image contains no compiler, no build cache and no source — a separate build stage keeps them out.
- Deployments reference an immutable digest, and the digest in production is the one that passed testing.
- Build-time secrets use a mount, never a build argument or an intermediate layer.
- Images run as a non-root user, and the base image is rebuilt on security updates rather than only on code changes.
- Base images are scanned on build, and a failing scan blocks the release rather than filing a ticket.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Cloud Native](../../../themes/cloud-native.md) — The unit the platform can actually schedule {#fluency-cloud-native}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Stateless Service](../routing/stateless-service.md) — An image is replaced rather than patched, so anything held in the container is lost on the next deploy
- [Blue-Green Deployment](../routing/blue-green-deployment.md) — Promoting one digest between environments is what makes the two sides genuinely identical
- [Quarantine](../../security/quarantine.md) — A built image from a public source enters through quarantine before anything pulls it.

**Enables**

- [Compute](../../../capabilities/compute.md) — Serverless container runtimes and managed Kubernetes both start from an image; the platform runs it and never builds it.
- [Container Orchestration](./container-orchestration.md) — The orchestrator schedules and replaces images; this is what decides what is inside one

<!-- relationships:end -->
