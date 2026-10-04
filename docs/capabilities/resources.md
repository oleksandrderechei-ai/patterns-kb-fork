---
title: Resource Organisation
description: "The account, subscription or project everything lives in — and what deleting it takes with it"
area: capabilities
owner: Oleksandr Derechei
tags: [operations, boundaries, resource-management, access-control, cloud]
status: stable
aliases: [accounts, projects, resource hierarchy, tagging]
solves: [I was told to use a resource group but this cloud has no such thing, deleting one thing took a dozen other things with it, our bill has one enormous line and nobody can say which team spent it, a test job could reach the production database because everything lives in the same place, we hit a limit nobody knew existed and the launch stalled while we asked for an increase]
---

# Resource Organisation

The containers, hierarchies and labels every cloud makes you organise resources inside — what each one bounds, what a new boundary costs you to draw, and why the same word means two different lifecycles on two clouds.

## What the cloud gives you here
<!--meta block=description-->

Every cloud makes you put a resource inside a container: an account on AWS, a subscription on Azure, a project on Google Cloud. The container decides your permission blast radius, your bill and what deleting it takes with it, so it sets how coarse [least privilege](../patterns/security/least-privilege.md) can get. The three translate well enough to draw one diagram and not well enough to port scripts, because they differ on whether the container is optional and what it cascades.
## Explained
<!--meta block=explain-->

A resource container is the account, subscription or project that every cloud resource must live inside. It sets your permission blast radius, your bill, and what is deleted along with it. Draw a boundary where you want a mistake to stop at a wall: always one per environment, with production alone, one per team where teams must not reach each other's data, and one per tenant where a tenant's trouble must stay its own. Choose the layout you will want in two years, because a resource rarely moves between containers afterwards.

- **Cross-container work needs explicit wiring** Make a container the product of a template, not a click, so one more costs a pull request.
- **Tags decay once optional** Reject an untagged resource at creation, not in a monthly report.
- **Quotas count per container and per region** A fine layout multiplies increase requests, so check the limits your design leans on before you commit.

**Example.** A company has 4 teams and 3 environments, giving 12 containers. It needs a GPU quota increase in 2 regions. Each container is counted separately, so that is 12 times 2, or 24 requests, each with a lead time. A layout with one container per environment would need 3 times 2, or 6. The finer layout buys isolation: a team's runaway job exhausts only its own quota. The cost is 18 extra requests, which you pay by asking in the quarter before you need the capacity.

## The capabilities
<!--meta block=capabilities-->

- **Billing and permission boundary** — The container everything else hangs off: it owns the bill, the identity policies and the quota counters. It is also the coarsest and cheapest isolation the cloud sells, which is why the first boundary anyone draws is the one around production.
- **Organisational hierarchy** — A tree of containers above the boundary, so one policy or one permission grant reaches many at once. Put production on its own branch first, because a rule attached to a branch is the rule nobody can forget to apply to next month's new container.
- **Mandatory grouping container** — A required object every resource belongs to, sitting between the boundary and the resource. Where one exists it is also the lifecycle unit, which makes tearing an environment down a single call and makes a mistyped delete unrecoverable.
- **Metadata labels** — Key-value pairs on a resource carrying what the hierarchy cannot: owner, environment, cost centre, ticket. They are how you answer what a team or a feature costs, and they only work if every resource carries them, which means enforcing them at creation rather than auditing them later.
- **Policy enforcement** — Rules the platform evaluates for you, attached to a node in the hierarchy and inherited downward. They come in two shapes — capping what a principal may do, and constraining what a resource may look like — and a rule that denies at creation time costs nothing, while a report of what is already wrong costs a remediation project.
- **Quotas and service limits** — Per-container, per-region ceilings on how much of a service you can create. They are the platform's own defence against a [noisy neighbour](../hazards/noisy-neighbour.md) and the limit you meet long before price becomes the constraint, so find the ones your design leans on while it is still a design.
- **[Infrastructure as code](../comparisons/infrastructure-as-code.md)** — A template in your repository that creates the containers, the policies and the resources, so an environment is a build output instead of somebody's memory. It is the precondition for every other capability here, because a boundary drawn by hand is a boundary you cannot reproduce or review — the [design for operations](../principles/design-for-operations.md) argument applied to the infrastructure itself.
- **[Deployment grouping](../patterns/distributed/routing/deployment-stamp.md)** — Treating one complete copy of the stack as the unit you create, update and throw away. Bind that copy to a container boundary and rolling back a bad environment becomes deleting it, rather than repairing it in place with users on it.
- **Cost attribution and analysis** — Reports that split the bill by container, by hierarchy node and by label. What you can attribute today was decided months ago by the tagging you enforced, because an untagged resource lands in a bucket called other and never comes back out — which is where [the business](../principles/build-for-business.md) loses the ability to price its own features.
- **Landing zone** — A prepared baseline — hierarchy, guardrail policies, central logging, and a repeatable way to hand a team a container that is already compliant. Build one before the tenth team asks for an environment, because retrofitting policy onto containers full of running resources means breaking things people depend on.
- **Globally unique resource identifier** — The string that names one resource unambiguously across the whole provider, carrying its container and usually its region and type. Every provider's format differs, so anything that parses one — a log pipeline, a policy condition, an asset inventory — is provider-specific by construction.
- **Deletion protection** — An explicit lock that makes a resource or a container refuse to be deleted until someone removes the lock first. Pay the friction exactly where the delete is unrecoverable, and expect that list to be longer than the one your team can name from memory.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Billing and permission boundary | account | subscription | project | no direct open-source equivalent |
| Hierarchy above the boundary | AWS Organizations, organizational units | management groups | organization, folders | no direct open-source equivalent |
| Mandatory container for every resource | none — resources live in the account | resource group | project | no direct open-source equivalent |
| Metadata labels | tags | tags | labels | no direct open-source equivalent |
| Policy enforcement | service control policies, AWS Config | Azure Policy | Organization Policy Service | Open Policy Agent |
| Quotas and limits | Service Quotas, per account and region | quotas, per subscription and region | quotas, per project and region | no direct open-source equivalent |
| Native infrastructure as code | AWS CloudFormation, AWS CDK | ARM templates, Bicep | Infrastructure Manager (managed Terraform), successor to Deployment Manager | OpenTofu |
| Cost analysis | AWS Cost Explorer | Microsoft Cost Management | Cloud Billing reports | OpenCost |
| Third-party infrastructure as code | Terraform | Terraform | Terraform | OpenTofu, Pulumi |
| Landing zone tooling | AWS Control Tower | Azure landing zones | enterprise foundations blueprint, a reference rather than a managed service | no direct open-source equivalent |
| Resource identifier | Amazon Resource Name (ARN) | resource ID path under the subscription | relative resource name under the project | no direct open-source equivalent |
| Enabling a service before first use | no per-service step | register the resource provider | enable the API in the project | no direct open-source equivalent |
| Lock against deletion | no generic lock — per-service protection or a deny policy | resource lock | project lien | no direct open-source equivalent |
| Web console | AWS Management Console | Azure portal | Google Cloud console | no direct open-source equivalent |
| Browser shell | AWS CloudShell | Azure Cloud Shell | Cloud Shell | no direct open-source equivalent |

## Choosing between them
<!--meta block=choosing-->

Draw a new container wherever you want a mistake to stop at a wall. The layout that survives contact with an auditor starts at one container per environment, with production alone in its own, because the cheapest guarantee that a test job cannot read customer data is that it has no path to it. Everything finer than that is a judgement about how much cross-container plumbing you are willing to build and keep working.

| If you need… | Choose | Because |
| --- | --- | --- |
| Production kept away from everything else | A container per environment | The only isolation nobody can misconfigure past is one where the grant does not exist |
| One team's incident to leave the others working | A container per team or per tenant | It is a [bulkhead](../patterns/distributed/resilience/bulkhead.md) at the widest scope the cloud offers — quotas and blast radius stop at the wall |
| A rule that applies to containers you have not created yet | A policy at a hierarchy node, not on the resource | Inheritance is what stops next quarter's new container from being the exception |
| To know what a feature costs | Tags required at creation time | An untagged resource lands in other, and no later report can pull it back out |
| To hand a new team a compliant environment this week | A landing zone template | Reproducible from a repository; the alternative is one person's memory of the last one |
| To throw a bad environment away rather than repair it | One container per deployment stamp | Deleting a container is a supported operation; unpicking a half-broken one is not |
| A shared service many teams reach | Its own container, with explicit grants | Cross-container access becomes a decision you can review instead of a side effect of everything living together |

Every boundary you add is paid for in plumbing. Networking, shared services, log aggregation and any query that spans containers all need wiring you would otherwise get free, and quotas are counted per container, so twenty containers means twenty separate increase requests. The counter-move is to stop treating a container as something a person creates: put its creation, its policies and its baseline in the same template as everything else, and the marginal cost of one more falls to a pull request. Skip that step and you get the opposite failure — one enormous container holding nine hundred resources nobody can attribute, which is a [big ball of mud](../hazards/big-ball-of-mud.md) with a billing account attached.

Choose the boundary you will want in two years, because a resource rarely crosses one afterwards. Azure moves many resource types between resource groups and subscriptions with restrictions that vary by type, Google Cloud moves a project between folders but generally not a resource between projects, and AWS moves an account between organizational units and never a resource between accounts. So the real migration plan is a [blue-green](../patterns/distributed/routing/blue-green-deployment.md) one: build the new container from the template, move the data, shift traffic, delete the old. That plan only exists if the template does, which is the argument for infrastructure as code stated as a cost rather than a virtue.

## What does not port
<!--meta block=portability-->

- **Resource group is one word for two lifecycles**: deleting an Azure resource group deletes every resource inside it, while deleting an AWS resource group deletes nothing, because there it is a saved query over tags. The same sentence in a runbook is a tear-down on one cloud and a no-op on the other, so never port a clean-up script between them on the strength of the name.
- **One cloud demands a container, another has none**: every Azure resource belongs to exactly one resource group that must exist first, and Google Cloud requires a project the same way; AWS resources sit directly in the account. A template moved off Azure carries a grouping decision AWS has nowhere to put, and one moved onto Azure is missing a decision you now have to make for every resource.
- **Tag casing flips between clouds**: AWS treats tag keys and values as case-sensitive, Azure treats tag names as case-insensitive for operations while values stay case-sensitive, and Google Cloud labels must be lowercase. A key called Environment does not survive the trip to a label, and a cost report keyed on the casing you assumed reports zero without erroring.
- **Quotas are per container, per region, and asked for differently everywhere**: they are the ceiling you meet before price becomes a constraint, and splitting into many containers multiplies the number of increases you must request. Find the quotas your design depends on during design, because an increase is a request with a queue behind it and a launch date does not wait for it.
- **Cost attribution is free on one boundary and earned on another**: an Azure resource group and a Google Cloud project split the bill by construction, while on AWS a tag key does nothing for cost reports until you activate it as a cost allocation tag. Activation is not retroactive, so every month before somebody noticed stays unattributable.
- **Inheritance covers a different object on each cloud**: Azure Policy can copy a tag from the resource group onto resources that lack it, AWS inherits nothing from an organizational unit or account, and on Google Cloud the object that inherits down the hierarchy is a Resource Manager tag, which is a different feature from a label with a different API and different permissions. A tagging strategy that assumed inheritance produces a bill you cannot split.
- **Identifier formats share nothing**: an ARN, an Azure resource ID path and a Google relative resource name differ in shape, in which segments carry the container and region, and in how the container itself is named — an AWS account is a number you are given, an Azure subscription is a GUID, and a Google Cloud project ID is a string you choose that must be unique across every customer and can never be changed. Anything that parses or generates one is rewritten per cloud, not ported.
- **Preventive policy is expressed against different things**: AWS caps a principal's permitted actions with service control policies and detects non-compliant configuration afterwards with AWS Config, while Azure Policy and Google's organization policies constrain what a resource may be and can refuse the creation outright. Porting a guardrail means restating the intent in the other shape, and a control that was preventive can quietly arrive as a report.

## Patterns it implements
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Design for Operations](../principles/design-for-operations.md) — Hierarchy, tags and policy are the surfaces operators actually work through.
- [Least Privilege](../patterns/security/least-privilege.md) — The account or project boundary is the coarsest scope a permission can be granted at.

**Generalizes**

- [Infrastructure as Code](../comparisons/infrastructure-as-code.md) — The IaC product decision, argued in full

**Prevents**

- [Noisy Neighbour](../hazards/noisy-neighbour.md) — An account or project boundary is the blast radius; quotas per boundary are what stop one tenant starving another.

**Implements**

- [Authorization Enforcer (RBAC)](../patterns/security/authorization-enforcer.md) — Resource policy is evaluated centrally and denies by default, so a non-compliant resource is never created.
- [Multi-Tenancy](../patterns/distributed/routing/multi-tenancy.md) — One account, subscription or project per tenant is the strongest isolation tier a cloud sells.

<!-- relationships:end -->
