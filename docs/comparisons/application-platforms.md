---
title: Application Platforms
description: "Heroku, Render, Fly.io, the cloud's own platforms and self-hosted PaaS — how much operating you are buying out of"
area: comparisons
owner: Oleksandr Derechei
tags: [operations, cloud]
status: stable
aliases: [Heroku, Render, Fly.io, PaaS, platform as a service]
solves: [we have no one to operate servers and need this deployed by Friday, our platform bill has outgrown what the same thing would cost as containers, we want to leave our hosting platform without rewriting how we deploy, which managed platform will not trap us when we outgrow it, we need a private network and the platform we picked cannot reach one]
---

# Application Platforms

Products that take a repository and give back a running, routable, TLS-terminated service — and differ mainly in how much of the operating you are buying out of, and what it costs you to leave.

## The decision
<!--meta block=description-->

Every product here turns source code into something on the internet: it builds, runs, routes traffic, terminates Transport Layer Security (TLS) and holds configuration and secrets. The differences sit beyond that line: scaling, database cost, private networking and how much survives leaving. Who will operate it decides most of the choice, because a platform's value is engineer-hours you do not spend. Ask the exit question before adopting. Prices move fast, so verify each against the vendor's page.
## Explained
<!--meta block=explain-->

An application platform takes your source code and gives back a running service on the internet, with the build, routing, TLS and secrets handled. The products differ in who does the operating, so the choice turns on that, not on features. Default to your existing cloud's own platform when you have one, because your data, identity and private network are already there. For new work with an unknown future, pick a container-native platform, which runs a standard container image and so lets you leave cheaply. A platform with its own build system and add-ons is fastest to start on and hardest to leave, so choose it only when speed to first deploy dominates. If traffic is bursty with real idle time, let scale-to-zero, paying nothing while no request arrives, filter the list first.

- **Exit cost grows with platform-specific features.** A standard image leaves in about a sprint; its own build system and add-ons take a rebuild.
- **A platform may not model what you need.** A local disk, a non-HTTP protocol or a GPU may mean running the orchestrator yourself.
- **Self-hosting to save money moves the work.** The platform was doing it, so self-host only once you can operate it.

**Example.** Illustrative numbers. A platform costs 400 dollars a month more than the equivalent raw servers. Running the same setup yourself takes 8 hours a month of an engineer's time, valued at 80 dollars an hour, or 640 dollars. The platform wins, and the break-even is 400 divided by 80, or 5 hours a month. If you later cut that work to 3 hours, or 240 dollars, running it yourself wins. The cost you accept up front is the exit: if the app runs as a standard image, leaving takes about a sprint, and with the platform's own build system and add-ons it takes a rebuild.

## The contenders
<!--meta block=contenders-->

- **Heroku** — The product that defined the category and supplied its vocabulary — dynos, buildpacks, add-ons, and the twelve-factor discipline that came out of operating it. Proprietary, owned by Salesforce. Push a repository, a buildpack detects the language and produces a runnable artifact, and an add-on marketplace supplies databases and everything else. Its abstractions are the highest-level here, so it is the fastest to start on and the hardest to leave. Since February 2026 it has been in sustaining engineering, so plan your exit before you need a feature it does not have.
- **The cloud's own platforms** — AWS Elastic Beanstalk and App Runner, Azure App Service and Container Apps, Google Cloud Run and App Engine. Proprietary, billed by usage or for the underlying resources. The reason to prefer one is rarely the platform itself: it is that your data, your identity model and your private network are already there, so the platform is inside the perimeter instead of calling into it.
- **Container-native platforms** — Render, Railway, Fly.io and similar: proprietary services that take a repository or an image, run it as a container, and add managed databases and private networking around it. The differentiator against the older generation is that the unit is a standard container image, so what you build here also runs anywhere else — which is what makes the exit cheap.
- **Self-hosted PaaS** — Dokku, Coolify, CapRover and Knative-based platforms: open-source software you run on your own machines to get a platform experience on top of them. Knative sits on a Kubernetes cluster you must already run. You pay the server bill and the operating cost, and in exchange there is no per-service premium and no vendor to be repriced by. Worth it when you already run infrastructure; a poor trade when you do not.
- **Orchestration you run yourself** — Not a platform at all, and the honest comparison point at the bottom of the range: a Kubernetes cluster plus the ingress, certificates, pipeline and observability that a platform would have handed you. Everything is possible and nothing is provided, which is the correct trade once you have a team whose job this is.

## How they compare
<!--meta block=matrix-->

| Criterion | Heroku | Cloud's own platform | Container-native | Self-hosted PaaS |
| --- | --- | --- | --- | --- |
| What you hand it | a repository | a repository or an image | a repository or an image | a repository or an image |
| Deployable unit | the platform's own artifact | image, or a runtime bundle | a standard container image | a standard container image |
| Cost of leaving | high — build, add-ons and routing are all its own | moderate — inside one provider | low — the image runs anywhere | low for the app; the platform's operating work stays with you |
| Who operates it | the vendor | the provider | the vendor | you |
| Reaches your existing private network | an add-on concern | yes, natively | varies by product | yes, it is your network |
| Scale to zero | no | yes on the request-driven products | varies by product; check the vendor's docs for idle behaviour | only with a platform that supports it |
| Where databases come from | the add-on marketplace | the provider's managed databases | the platform's own managed offerings | you run them, or rent them elsewhere |
| Compliance and residency control | limited to the vendor's regions | full, via the provider's controls | limited to the vendor's regions | full — it is your hardware or account |
| What the premium buys | the most operating removed, from a platform in sustaining engineering since February 2026 | integration with what you already run | operating removed without lock-in | nothing — you traded money for time |

## Choosing
<!--meta block=choosing-->

Start with the null option, which here is unusually strong: if your workload already lives on one cloud, that cloud's own platform is the default and the burden of proof is on anything else. Your data, identity and private network are already there, the bill is one bill, and the platform is inside the perimeter rather than punching through it. Nothing below beats that unless it answers a question this does not.

Choose a container-native platform when you want the operating removed but not the option to leave. The unit of deployment is a standard image, so the platform is a convenience layer over something portable — which makes it the best default for a new product whose future infrastructure you cannot yet predict, and the reason this category has largely displaced the older one for greenfield work.

Choose the highest-level proprietary platform when speed to first deploy genuinely dominates and the application is conventional. Its abstractions are the most opinionated on offer, and for a small team shipping a standard web application that is a real advantage rather than a compromise. Go in knowing the exit is expensive: the build system, the add-ons and the routing are all its own, so leaving is a rebuild rather than a redeploy.

Choose self-hosted when you already operate infrastructure and the per-service premium has become a visible line item, or when residency and compliance rule out the alternatives. The mistake is adopting it to save money before you have the operational capability, because the platform you are replacing was doing work that does not stop being necessary once you stop paying for it.

Two conditions override everything above. If any of your services needs something the platform does not model — a persistent local disk, a non-HTTP protocol, a sidecar, a GPU — then a platform that abstracts those away is not a simplification but an obstacle, and running the orchestrator yourself is the honest answer. And if the workload is bursty and request-driven with real idle periods, scale-to-zero usually outweighs the other criteria: measure the idle share from your request logs, and if it is real, let the products that offer scale-to-zero filter the list before you compare anything else.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Compute](../capabilities/compute.md) — The managed-platform product decision inside the compute capability

**Requires**

- [Stateless Service](../patterns/distributed/routing/stateless-service.md) — The platform replaces instances freely, so anything held in a process is lost

**Implements**

- [Autoscaling](../patterns/distributed/routing/autoscaling.md) — Scaling on request rate or concurrency is the platform's job, configured rather than built
- [Containerization](../patterns/distributed/coordination/containerization.md) — Container-native and self-hosted platforms run a standard container image, so the image is the unit you can carry to another platform.

<!-- relationships:end -->
