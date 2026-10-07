---
title: Host Header Rewriting
description: "A proxy replaces the requested host name, so the backend builds links, cookies and redirects for the wrong domain"
area: hazards
owner: Oleksandr Derechei
tags: [routing, error-handling, edge]
status: stable
aliases: [host override, host header override, lost original host]
solves: [users get logged out at random and the server sees a brand-new session every time, the password reset email links to an internal address nobody should see, sign-in fails because the identity provider says the redirect URI is not registered, the site redirects the browser to the hosting platform default domain, requests are reaching the app directly and skipping the firewall in front of it]
---

# Host Header Rewriting

A reverse proxy forwards a request under the backend's own host name instead of the one the browser asked for. Everything the application computes from the host — absolute links, redirect URLs, cookie domains — is then built for a domain the user never visited, and each of those failures looks like a different bug.

## What it is
<!--meta block=description-->

Host header rewriting is a reverse proxy replacing the domain the browser asked for with the backend's own address before forwarding. You recognise it by symptoms that look unrelated: users logged out at random, redirects landing on a backend domain, a sign-in provider rejecting its callback. The page still renders, so nothing fails loudly. The defining trait is that the application builds cookies and links from a host the user never typed.

## Explained
<!--meta block=explain-->

Host header rewriting is a [reverse proxy](../patterns/distributed/routing/reverse-proxy.md), the server that receives browser traffic and forwards it to your application, replacing the domain the browser asked for with the application's own address. The request still arrives and the page still renders, so nothing looks wrong. But the application builds cookies, redirects and absolute links from the host it sees, so it issues them for the wrong domain. The browser drops a cookie set for the backend's domain, so users are logged out at random. A redirect that names the backend sends the browser around the proxy and skips any firewall or rate limit there. It usually starts as a shortcut, since a hosting platform refuses a domain it has not been told about. Preserve the original host instead, and register your real domain with the platform. Where preserving is impossible, forward the host in the X-Forwarded-Host header and make your framework trust it only from known proxy addresses.

- **Domain setup.** You add a verification record in DNS and a certificate for the public name on the backend.
- **Trusted proxies.** If you forward the host in a header, list the proxy addresses your framework trusts, or clients can spoof it.

**Example.** A shop runs at shop.example.com, and the proxy forwards to app-7.hosting.example, the platform's default address. The proxy sends that address as the host. After sign-in the framework sets a cookie with `Domain` app-7.hosting.example, taken from the host it sees, the browser never returns it to shop.example.com, and every later request looks anonymous. The sign-in provider also rejects the callback, because only https<!-- -->://shop.example.com/callback is registered. Three symptoms share one setting. The fix is to register shop.example.com with the platform, then switch off the override.

## How it happens
<!--meta block=causes-->

Most often as a shortcut that worked. A managed platform routes incoming requests to the right tenant by host name, so it rejects a request for a custom domain it has not been told about. Overriding the host with the platform's default address makes the rejection disappear in one setting, and the site comes up. Registering the domain with the platform is the step that gets skipped, because at that moment it looks like extra work for no visible gain.

Some proxies also do it without being asked. Where the default is to take the host from the backend address, the override is inherited by every route anyone adds, and nobody has to make a decision for it to be wrong. Health probes push the same way: a probe runs outside any client request and therefore has no original host, so configuring it with the backend's own address is natural, and if the probe's setting is the one the request path also reads, that choice becomes the behaviour for real traffic.

The last route in is a network device checking its own consistency. A firewall inspecting HTTP between the proxy and the backend may verify that the `Host` header resolves to the address it is being sent to, and the preserved public host resolves to the proxy, not the backend. The obvious fix is to rewrite the host; the correct one is split-horizon DNS, where the public name resolves to the proxy from the internet and to the backend from inside. Taking the obvious fix reintroduces every symptom below, at a layer the application team cannot see.

## What it costs
<!--meta block=cost-->

Every failure it causes is silent at the point of failure. The backend answers correctly, logs nothing unusual, and returns a value that is wrong in a way only the browser can notice. So the cost is paid mostly in diagnosis: three unrelated-looking symptoms (vanished sessions, a broken sign-in, a strange URL in an email) that share one cause nobody is looking at, because the request itself never failed.

Broken cookies are the most expensive of the three. A cookie issued with an explicit `Domain` naming the backend is never sent back to the real site. A cookie with no `Domain` attribute is host-only and survives, but absolute URLs and redirects still break. Session state can reset at random moments, and session state resets at random moments and [sticky-session](../patterns/distributed/routing/sticky-session.md) affinity stops working. Users report being logged out; the server sees a first-time visitor. There is no error to search for, and nothing in the application's own logs distinguishes it from someone who cleared their cookies.

The security cost is the one that outlasts the bug. An absolute URL naming the backend hands the browser a route that goes directly to the application and around the proxy, and if that proxy is also your web application firewall, your rate limiter or your authentication gate, those controls have just been made optional by a header. In a browser-based sign-in flow the same leak means the redirect URI names the backend, so either the identity provider rejects the login outright, or, if someone once registered that internal URL to make an environment work, the authenticated session completes outside the edge entirely. Restricting the backend to accept only proxy traffic reduces the bypass and the session-completion risk to a leaked internal name; the cookie and callback breakage remain.

## Getting out
<!--meta block=mitigation-->

Preserve the original host, and make the backend able to accept it. Register the public domain with the hosting platform so it stops rejecting the request — verification is normally a text record, so the domain's own DNS keeps resolving to the proxy — then turn off whatever setting overrides the host or picks it from the backend address. The application usually needs no change, because it goes back to seeing the domain the browser used.

Where preserving it is genuinely impossible, forward the original instead and teach the application to read it. `X-Forwarded-Host` carries the host, `X-Forwarded-Proto` the original scheme, `X-Forwarded-For` the client address; most web frameworks have forwarded-header handling, usually off by default. Turn it on only for known proxy addresses, because a forwarded header from an untrusted source is a client telling you what domain and what scheme to believe. An attacker can use that to poison password-reset links and cached pages. Some proxies send the standard `Forwarded` header (RFC 7239) instead; enable whichever your proxy emits.

Then close the two gaps the fix leaves open. Health probes carry no original host, so configure one explicitly on the probe rather than letting it borrow the request path's behaviour; a typical probe ignores a wrong cookie or redirect. A stable custom domain here is for consistency. And end-to-end TLS to the backend now needs a certificate for the public domain installed on the backend as well, which is a renewal to automate rather than a reason to go back. Whichever route you take, lock the backend down to accept traffic only from the proxy. It is the control that turns any remaining leak into a cosmetic one.

Verify it rather than assuming it. Request the site through the proxy and check three things in the response: the `Location` header on any redirect names the public domain, every `Set-Cookie` either has no `Domain` attribute or names the public domain, never the backend host, and the sign-in flow's redirect URI matches what is registered with the identity provider. All three go wrong together the moment a route is added with the override still on.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Mitigated by**

- [Reverse Proxy](../patterns/distributed/routing/reverse-proxy.md) — Configure the proxy to pass the incoming host through rather than picking it from the backend address
- [API Gateway](../patterns/distributed/routing/api-gateway.md) — Check the origin host header setting on the gateway; blank usually means preserve, and preserve is what you want
- [Gatekeeper](../patterns/distributed/routing/gatekeeper.md) — A leaked backend address is only exploitable while the backend still answers requests that did not come through the edge

**Threatens**

- [Load Balancer](../patterns/distributed/routing/load-balancer.md) — Host rewriting at the balancer breaks cookies and redirects behind it
- [Sticky Session](../patterns/distributed/routing/sticky-session.md) — Sticky-session affinity stops working once the host is rewritten

<!-- relationships:end -->
