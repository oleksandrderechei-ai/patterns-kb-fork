---
title: Networking
description: "The private network, its firewalls and load balancers, and the ways in and out"
area: capabilities
owner: Oleksandr Derechei
tags: [routing, load-balancing, boundaries, cloud]
status: stable
aliases: [cloud networking, VPC, VNet]
solves: [I know the AWS networking service but not what Azure or Google Cloud call it, my machines cannot reach the internet to install packages and I do not know what is missing, two networks are joined to the same hub and traffic between them still will not route, the firewall rules I ported allow the right traffic but something is still being blocked, I cannot tell which of the two load balancers this cloud sells I am supposed to use]
---

# Networking

The software-defined network a cloud hands you — an address space of your own, the subnets and routes inside it, the firewalls that filter them, and the balancers, edges, peerings and circuits that carry traffic in and out.

## What the cloud gives you here
<!--meta block=description-->

Every cloud sells you a private network before it sells you anything to put in it: an address range you choose, cut into subnets, each with a firewall and a route table. Nothing inside answers the internet until you attach a [Load Balancer](../patterns/distributed/routing/load-balancer.md) or an [API Gateway](../patterns/distributed/routing/api-gateway.md). The names change and the pieces do not, so most mapping is mechanical. Two things differ in kind: what a subnet spans, and how firewall layers work.
## Explained
<!--meta block=explain-->

A cloud network is a private address range you choose, cut into subnets, each with its own firewall and routing, with nothing reachable from the internet until you attach a way in, such as a load balancer. Plan the address ranges before the first subnet exists and leave room for the company you have not bought yet, because two networks with overlapping ranges can never be joined and renumbering a live network is the costliest mistake on offer. Choose a transit hub, one central joining point, over direct links once you have more than three or four networks, because direct links are not passed along and a full mesh grows as n squared.

- **The hub is metered** Each attachment bills by the hour and by the gigabyte carried, so keep chatty services within one network.
- **Managed boxes bill for existing** Address translation, balancers and private endpoints bill per hour and per gigabyte, so keep chatty services together and cache reads.
- **Subnet scope and firewall layering differ by provider** Port the intent, not the configuration, and test the deny paths before cutover.

**Example.** A company has 5 networks, each linked directly to every other: 5 times 4 divided by 2, or 10 links. An acquisition makes 6 networks, which is 15 links, and at 10 networks it is 45. Joined through a hub, each network has one attachment, so 10 networks need 10. The hub's cost is that each attachment bills by the hour and by the gigabyte carried. Worse, the acquired network uses the same 10.0.0.0/16 range as yours, so it cannot join either way until one side is renumbered.

## The capabilities
<!--meta block=capabilities-->

- **Software-defined private network** — An address range you pick, isolated from every other tenant, inside which your machines find each other by private address. It is the outermost unit of isolation on every cloud: two resources in different private networks cannot reach each other at all until you deliberately join them.
- **Subnet** — A slice of that address range with its own route table and its own firewall posture. It is how you keep what may face the internet apart from what may not, and it is the one construct whose scope differs in kind between providers.
- **Stateful instance firewall** — A rule set attached to a machine's network interface that admits traffic by protocol, port and source, and lets the return traffic back without a second rule. Write almost all your rules here, because this layer follows the workload rather than the address the workload happens to have today.
- **Custom routing** — A per-subnet table saying where traffic for a destination range goes: out to the internet, through a NAT (network address translation) device, across a peering, or into an appliance you run. Changing one entry re-routes every machine in the subnet at once, which is how an inspection appliance gets inserted without touching a single workload.
- **Outbound NAT** — A managed device that lets machines with no public address reach the internet, while nothing on the internet can open a connection back to them. It is what a private subnet needs to install packages or call a third-party API, and it is metered both by the hour it exists and by the gigabyte it carries.
- **[Layer-4 load balancer](../patterns/distributed/routing/load-balancer.md)** — Forwards connections to a pool of backends on addresses and ports without reading what is inside, which lets it carry any TCP or User Datagram Protocol (UDP) protocol at the least added latency. Its health check is the only thing keeping a failing backend out of the pool, and a pool that keeps taking traffic while it fails is the usual first step of a [Cascading Failure](../hazards/cascading-failure.md).
- **[Layer-7 load balancer](../patterns/distributed/routing/reverse-proxy.md)** — Terminates the client's connection, reads the HTTP request, and routes it on host, path or header. That is what buys per-route backends, Transport Layer Security (TLS) termination and header rewriting, and it is where a web application firewall attaches — the [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) pattern, bought rather than built.
- **[Global edge and content delivery network (CDN)](../patterns/distributed/routing/cdn.md)** — A worldwide set of points of presence that terminate the user's connection close to them and carry the rest over the provider's own backbone. It caches what is cacheable and shortens the handshake for what is not, which together are most of the latency a distant user feels.
- **Authoritative DNS** — A managed zone that answers lookups for your domain, with health checks and routing policies that can return a different address per region or per client location. It is the cheapest region-level failover you own and the slowest, because clients keep the old answer for as long as the record's TTL (time to live) told them to.
- **Network peering and transit** — A direct private join between two networks, and a hub service for when there are more than a few. Peering is not transitive on any provider, so a full mesh of n networks costs n² links; the hub replaces them with one attachment each and bills you for the privilege.
- **Private connectivity to managed services** — A private address inside your own network that resolves to a managed service, or to a service another tenant publishes, so the traffic never crosses the internet. It removes the public endpoint from the path, which is what most data-exfiltration controls actually require of you.
- **Hybrid connectivity** — Two ways to join your own datacentre to the cloud network: an encrypted tunnel over the public internet, and a dedicated circuit into the provider's edge. The tunnel is up in an hour and capped by what one tunnel will pass; the circuit takes weeks to provision and gives you bandwidth and latency you can plan against.

## What each cloud calls it
<!--meta block=mapping-->

| Capability | AWS | Azure | Google Cloud | Open source |
| --- | --- | --- | --- | --- |
| Software-defined private network | Virtual Private Cloud (VPC) | Virtual Network (VNet) | VPC | OpenStack Neutron |
| Subnet | subnet, one Availability Zone | subnet, spans the region | subnet, spans the region | no direct open-source equivalent |
| Stateful instance-level firewall | security group | network security group | firewall rules | nftables |
| Stateless subnet firewall | network ACL | no first-party equivalent | no first-party equivalent | nftables |
| Custom routing | route tables | user-defined routes | routes | no direct open-source equivalent |
| Outbound NAT | NAT gateway | Azure NAT Gateway | Cloud NAT | Linux NAT (nftables) |
| Layer-4 load balancer | Network Load Balancer | Azure Load Balancer | passthrough Network Load Balancer | [HAProxy](../comparisons/load-balancers-and-gateways.md) |
| Layer-7 load balancer | Application Load Balancer | Azure Application Gateway | Application Load Balancer | NGINX, HAProxy |
| Global edge and CDN | Amazon CloudFront | Azure Front Door | Cloud CDN | Varnish (cache only) |
| Managed API gateway | Amazon API Gateway | Azure API Management | API Gateway, Apigee | Kong Gateway, Envoy |
| Session affinity to one backend | ALB target group stickiness | Application Gateway cookie-based affinity | backend service session affinity | NGINX ip_hash, HAProxy cookie |
| Authoritative DNS | Amazon Route 53 | Azure DNS | Cloud DNS | BIND, PowerDNS |
| Network peering | VPC peering | virtual network peering | VPC Network Peering | no direct open-source equivalent |
| Transit hub | AWS Transit Gateway | Azure Virtual WAN | Network Connectivity Center | no direct open-source equivalent |
| Private connectivity to managed services | AWS PrivateLink | Azure Private Link | Private Service Connect | no direct open-source equivalent |
| Web application firewall | AWS WAF | Azure Web Application Firewall | Cloud Armor | ModSecurity, Coraza |
| Request rate limiting at the edge | AWS WAF rate-based rules, API Gateway throttling | API Management rate-limit policy, Front Door WAF rate limiting | Cloud Armor rate limiting, Apigee quota policy | NGINX limit_req, Envoy rate limit filter |
| Dedicated private circuit | AWS Direct Connect | Azure ExpressRoute | Cloud Interconnect | no direct open-source equivalent |
| Site-to-site virtual private network (VPN) | AWS Site-to-Site VPN | Azure VPN Gateway | Cloud VPN | WireGuard, strongSwan |
| Service mesh | AWS App Mesh retired on 30 September 2026; Amazon VPC Lattice, ECS Service Connect | Istio-based add-on for Azure Kubernetes Service | Cloud Service Mesh | Istio, Linkerd |
| Service discovery | AWS Cloud Map | no registry service; Azure Container Apps resolves apps by name | Service Directory | Consul, CoreDNS |
| Managed WebSocket connections | Amazon API Gateway WebSocket APIs | Azure Web PubSub | no first-party equivalent | Socket.IO, Centrifugo |

## Choosing between them
<!--meta block=choosing-->

Decide how traffic gets in, then how it gets out, then which segments may talk to each other. The way in is the choice that costs most to reverse, because it fixes where TLS terminates, where a request filter can attach, and which failure domain your front door lives in.

| If you need… | Choose | Because |
| --- | --- | --- |
| HTTP traffic routed on host or path | Layer-7 load balancer | Only a balancer that reads the request can route on a URL, and it is where TLS and a request filter attach |
| Raw TCP or UDP, or TLS you terminate yourself | Layer-4 load balancer | Forwards packets without parsing them, so it carries any protocol and adds the least latency |
| Users spread across continents | Global edge in front of a regional balancer | Terminating near the user removes most of the handshake cost, and the long haul runs on the provider backbone |
| Machines in a private subnet that must call out | Outbound NAT | Gives egress without giving anything on the internet a way in |
| A managed service reached without a public endpoint | Private connectivity to that service | Keeps the traffic on the provider network, which is what exfiltration controls are written against |
| More than three or four networks joined | Transit hub | Peering is not transitive, so a mesh grows as n² connections while a hub grows as n |
| Your own datacentre joined for steady bulk traffic | Dedicated private circuit | Bandwidth and latency you can plan against; a tunnel over the internet is capped and shares the path |
| Region-level failover for a public name | Authoritative DNS with health checks | The cheapest failover you own, bounded by how long clients cache the answer |

Put almost every rule in the stateful firewall on the interface and almost none anywhere else. It follows the workload rather than the address, it admits return traffic without a second rule, and every provider lets a rule name a tag, a group or an identity instead of an address range — which is what stops the rule set rotting the next time the network is renumbered. Keep the coarser layers for the few denials that must hold even when someone edits an instance rule by mistake, and remember that none of this reaches inside a request: a [Service Mesh](../patterns/distributed/routing/service-mesh.md) is where per-call retries, mutual TLS and routing live.

The bill for a cloud network is mostly for the boxes that are not machines. Outbound NAT, load balancers, transit attachments and private endpoints are each metered by the hour they exist and usually by the gigabyte they carry, so traffic that never touched the internet still lands on an invoice. The counter-move is placement rather than negotiation: keep chatty services inside one zone and one network where you can, since crossing either boundary is metered on some providers, and put a cache in front of anything read more than once.

## What does not port
<!--meta block=portability-->

- **A subnet is not the same construct**: on AWS it lives in one Availability Zone, and on Azure and Google Cloud it spans the region. Copying an AWS layout gives the target three subnets where one would have done, and copying the other way strands a workload with no zonal spread at all.
- **Firewall layering has no common shape**: AWS pairs a stateful interface firewall with a stateless subnet filter, while Azure has one stateful layer plus workload tags to aim it with. Translating the allow rules leaves every deny path unproven, so work them out again on the target and test what is blocked rather than only what works.
- **Peering is never transitive**: two networks peered to a shared hub still cannot reach each other, on any of the three. A design that assumes spokes talk through the hub needs a transit service or an appliance in the path, and finding that out after the migration means re-drawing the routing.
- **The same control lives at a different scope**: a web application firewall attached to a regional layer-7 balancer and one attached to a global edge look identical in a feature matrix, and they differ in failure domain, in where the logs land, and in which requests they ever see. Match the attachment point, not the product name.
- **An anycast accelerator is not an edge network**: one product pulls your traffic onto the provider's backbone at the nearest point of presence and forwards it unchanged, another terminates HTTP at the edge and caches and rewrites it. They are sold in nearly the same language, so pick on whether you need caching and request inspection or only a shorter public path.
- **Quotas bind in different places**: how many public addresses one NAT device carries, how many ports it allocates per address, and how much a single VPN tunnel will pass are all different numbers on each provider. Port exhaustion on a NAT device reads as an outage of whatever you were calling, the same way [Connection-Pool Exhaustion](../hazards/connection-pool-exhaustion.md) does, so size against the target's own limits rather than the ones you are used to.
- **Private addresses do not always survive a move**: moving a resource between zones can mean giving it a new private address, so anything holding an address rather than a name breaks at exactly the moment you are recovering. Depend on names and service discovery, and treat a private address as a lease.
- **Health-check traffic comes from somewhere you did not expect**: each provider probes your backends from its own source addresses, and a firewall that does not admit them marks a healthy pool as dead. Port the rules that admit the probes along with the rules that admit users, because the symptom is an empty backend pool and nothing wrong with the backends.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Generalizes**

- [Load balancers, proxies & gateways](../comparisons/load-balancers-and-gateways.md) — The edge product decision inside this capability.

**Implements**

- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Layer-4 and layer-7 balancers are the pattern sold as a managed endpoint.
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Managed application programming interface (API) gateways front your services with auth, quotas and routing already built.
- [CDN](../patterns/distributed/routing/cdn.md) — The global edge network is this pattern, priced per gigabyte served.
- [Reverse Proxy](../patterns/distributed/routing/reverse-proxy.md) — The managed layer-7 balancer is a reverse proxy you configure rather than run.
- [Rate Limiter](../patterns/distributed/resilience/rate-limiter.md) — Gateway quotas and web application firewall (WAF) rate rules apply this at the edge, before your code runs.
- [Sticky Session](../patterns/distributed/routing/sticky-session.md) — Balancer affinity pins a caller to one backend without your code holding the mapping.
- [Intercepting Validator](../patterns/security/intercepting-validator.md) — A web application firewall is the choke point for request shape, sitting ahead of your code.
- [API Routing](../patterns/distributed/routing/api-routing.md) — A managed gateway matches host and path and forwards to the backing service, as configuration rather than code.
- [Token Bucket](../patterns/distributed/resilience/token-bucket.md) — Edge throttling is a token bucket: a steady refill rate plus a burst capacity, and nothing else to tune.
- [Service Mesh](../patterns/distributed/routing/service-mesh.md) — A managed mesh runs the sidecar proxies and control plane for you.
- [Circuit Breaker](../patterns/distributed/resilience/circuit-breaker.md) — Mesh outlier detection ejects failing backends without a library in your code.
- [Retry with Backoff](../patterns/distributed/resilience/retry-backoff.md) — Mesh retry policies re-send failed calls from the proxy.
- [Timeout / Deadline](../patterns/distributed/resilience/timeout-deadline.md) — Mesh route timeouts cap each call at the proxy.
- [Shadow Traffic](../patterns/distributed/routing/shadow-traffic.md) — Mesh traffic mirroring copies live requests to a second version.
- [Service Discovery](../patterns/distributed/routing/service-discovery.md) — A managed registry lets services find each other by name instead of address.
- [WebSocket](../patterns/messaging/websocket.md) — A managed service holds the long-lived client connections for you.
- [Single Access Point](../patterns/security/single-access-point.md) — A managed API gateway is the one front door to your services.
- [Leaky Bucket](../patterns/distributed/resilience/leaky-bucket.md) — The open-source edge proxy limits requests at a fixed drain rate.
- [Sidecar](../patterns/distributed/routing/sidecar.md) — A mesh injects a proxy sidecar beside every workload.
- [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) — A web application firewall is a managed gatekeeper: it inspects requests before they reach the service.
- [Ambassador](../patterns/distributed/routing/ambassador.md) — A mesh proxy does an ambassador's work: retries, TLS and routing on the client's behalf.
- [Strangler Fig](../patterns/distributed/coordination/strangler-fig.md) — An API gateway is the routing facade that sends each path to the old system or the new one.

<!-- relationships:end -->
