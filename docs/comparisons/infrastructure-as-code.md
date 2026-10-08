---
title: Infrastructure as Code
description: "Terraform, OpenTofu, Pulumi, Ansible and the cloud's own templates — provisioning or configuring decides it"
area: comparisons
owner: Oleksandr Derechei
tags: [operations, maintainability, cloud]
status: stable
aliases: [Terraform, OpenTofu, Pulumi, Ansible, IaC]
solves: [I cannot tell whether to describe infrastructure in a config language or a real programming language, our infrastructure tool changed its license and we need a fully open-source replacement, I cannot tell whether to create cloud resources or to configure machines with the same tool, our cloud's own templates cannot describe the second cloud we just adopted, nobody can review our infrastructure changes because they are written as a program]
---

# Infrastructure as Code

Four genuinely different approaches to describing infrastructure in a file: a declarative language with a state file, the same thing written in a programming language you already use, an agentless tool that configures machines rather than creating them, and the templates your cloud ships for free.

## The decision
<!--meta block=description-->

Settle which of two jobs you are doing first. Provisioning creates new resources and needs a record of what it made last time. Configuration management brings the contents of existing machines into line. Provisioning tools split into a declarative language and a general-purpose one. Both keep state, which you must store durably, lock and guard. A 2023 license change at Terraform, to the Business Source License, is why OpenTofu exists, so license now decides between the two.
## Explained
<!--meta block=explain-->

Infrastructure as code means you write down the servers, networks and databases you want in files, and a tool makes the real world match them. First settle which of two jobs you are doing. Provisioning creates resources that do not exist yet and needs a record of what it made last time, called state, to work out the difference. Configuration management changes the contents of machines that already exist, such as packages and files. If you are on one cloud and small, use that cloud's own templates: they are free and the provider keeps the state for you. Otherwise choose a declarative provisioning tool, mainly for its large set of provider plugins, and between the two main ones choose on license, because one changed to a source-available license in 2023 and the other is its open fork. Choose a general-purpose language only when your reviewers are programmers.

- **State is sensitive and racy.** It holds attribute values of everything it made, so store it durably, lock it and treat it as a secret.
- **Configuration management is not a provisioner.** A tool with no recorded state cannot show you its changes first.

**Example.** Two pipeline runs start 30 seconds apart. Each reads the state, sees no database, and plans to create one. Without a lock, both apply and you own 2 databases, one of them orphaned from the state and billing 300 dollars a month, illustrative, until someone finds it. With locked remote state, the second run waits for the first to finish, then plans 0 additions. The cost is that a crashed run can leave the lock held, so you also need someone permitted to release it.

## The contenders
<!--meta block=contenders-->

- **Terraform** — The declarative baseline, from HashiCorp — now part of IBM. Resources are described in its own configuration language, a plan shows the difference between the description and the recorded state, and an apply makes it so. Its provider ecosystem is the largest of any tool here, which is the main reason teams pick it. Licensed under the Business Source License since 2023, not open source in the OSI sense. Rent the workflow as HCP Terraform (HashiCorp Cloud Platform), or run it in your own pipeline.
- **OpenTofu** — The Linux Foundation fork of the last Mozilla-Public-Licensed Terraform release, created in response to that license change. It reads the same configuration language and the same providers, so adoption is largely a matter of changing the binary. The two have been diverging in features since the fork, so "compatible" is a shrinking claim rather than a permanent one. Choose it when the license is the deciding constraint.
- **Pulumi** — The same declarative model expressed in a general-purpose language — TypeScript, Python, Go, C# and others — so infrastructure is ordinary code with the tests, types, editor support and package manager that come with it. It keeps state and produces a preview exactly as the declarative tools do; what changes is who can read the source. Available as a managed backend or self-hosted state.
- **Ansible** — A different job, included because it is constantly compared to the others. Agentless configuration management from Red Hat under GPL-3.0: it connects over Secure Shell (SSH) or WinRM and runs tasks against machines that already exist. It keeps no state file, because it does not need one — it inspects each machine and converges it. It can create cloud resources through modules, and doing so gives you provisioning without the difference-detection the others are built around.
- **The cloud's own templates** — AWS CloudFormation, Azure Resource Manager templates and Bicep are provider-native. They are free and supported by the provider, and state is kept for you as part of the deployment, which removes the whole class of state-file operations. The cost is that they describe one cloud, and they typically support a new service on the provider's own schedule rather than the community's. Google Cloud's Infrastructure Manager is the exception: it runs Terraform configurations for you as a managed service, so it is Terraform rented, not a Google-only template language.
- **Typed configuration languages** — CUE, Dhall, Jsonnet and similar sit between the two provisioning styles: more expressive than a fixed configuration syntax, more constrained than a full programming language, and usually used to generate input for one of the tools above rather than to talk to a cloud directly. Reach for one when the problem is template sprawl across many similar environments rather than the provisioning itself.

## How they compare
<!--meta block=matrix-->

| Criterion | Terraform / OpenTofu | Pulumi | Ansible | Cloud-native templates |
| --- | --- | --- | --- | --- |
| Primary job | provision resources | provision resources | configure existing machines | provision resources |
| Description is written in | a purpose-built configuration language | TypeScript, Python, Go, C# and others | YAML playbooks | YAML or JSON, or Bicep on Azure |
| Keeps a state file you operate | yes — store, lock and protect it | yes — managed backend or self-hosted | no | no — the provider keeps it |
| Works across clouds | yes | yes | yes | one cloud only |
| License | Business Source License from 2023 (Terraform); Mozilla Public License (OpenTofu) | Apache-2.0 | GPL-3.0 | proprietary, no charge |
| Reviewability of a change | high — the plan is the diff | depends on how the code is written | high for tasks, low for overall end state | high — the change set is the diff |
| Reach for a brand-new service | provider maintainers add it; timing varies by cloud and service | native providers, or bridged Terraform providers; a bridged one can lag its source | module, varies by cloud | provider's own schedule |
| Testing story | plan assertions and policy checks | unit tests in the host language | check mode and idempotence runs | change-set preview |
| Skill it demands | one more configuration language to learn | the language plus the cloud model | operating-system administration | deep knowledge of one provider |

## Choosing
<!--meta block=choosing-->

Consider the null option first. If you are on one cloud, expect to stay, and your infrastructure is small, that provider's own templates cost nothing, need no state file operated by you, and are supported by the people who run the services. The reason most teams outgrow them is multi-cloud or the pace of provider support, and neither may ever apply to you.

Otherwise the declarative tool is the default, and the honest reason is the provider ecosystem rather than the language. Nearly everything you will want to manage — including things that are not cloud resources at all, like DNS registrars, identity providers and monitoring backends — already has a provider. Between the two, choose on license: pick OpenTofu when a permissive license is a requirement, and the original when it is not and you want the vendor's own managed workflow.

Reach for the programming-language option when the infrastructure itself is genuinely programmatic — many near-identical environments generated from a specification, or a platform team publishing reusable components as versioned packages to teams who consume them as libraries. The condition that should stop you is a team whose reviewers are not programmers, because the review of a plan is worth more than the expressiveness of the source.

Reach for the configuration-management tool when the thing you are changing is inside a machine you already have. It is also the pragmatic answer for anything with no API — an appliance, a legacy server, a network device reachable only over SSH. What it should not be is your provisioner: without recorded state it cannot tell you what it will change before it changes it, and losing the plan step is losing the main safety property of the whole practice.

The two are frequently used together, and the split is worth stating explicitly: provision the machine with one, configure its contents with the other. Where you can avoid the second half entirely, do — building an immutable image and replacing instances rather than converging them removes the drift that configuration management exists to correct. That is why this comparison matters less than it used to on container platforms, where the image is the configuration and the only thing left to provision is the cluster.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Specializes**

- [Resource Organisation](../capabilities/resources.md) — The product decision inside the capability that provisions and governs accounts

**Implements**

- [Deployment Stamp](../patterns/distributed/routing/deployment-stamp.md) — Stamping an identical environment per tenant or region is the thing these tools exist to make repeatable

<!-- relationships:end -->
