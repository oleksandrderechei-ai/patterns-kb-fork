---
title: Micro-Frontends
description: Split the UI into independently deployed slices
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, boundaries]
status: stable
aliases: [mfe]
solves: [two teams keep colliding in one giant frontend build, one small UI change forces a full rebuild and redeploy of the entire app, we want to migrate a legacy frontend page by page without a big-bang rewrite, one team failing a test blocks every other team from releasing, we cannot upgrade the framework because every team would have to move at the same time]
---

# Micro-Frontends

One user-facing application is composed from separately owned, independently deployed frontend pieces, so each team ships its slice without coordinating one monolithic build.

## What it is
<!--meta block=description-->

One frontend codebase with one build makes every release the slowest team's release: another team's failing test holds your finished feature. Micro-frontends cut the interface along ownership lines instead. Each slice is a whole vertical built and deployed by the team that owns it, and a shell assembles the slices into the one app the user sees.

## Explained
<!--meta block=explain-->

Micro-frontends split one web interface into slices, each owned by one team, built on its own and released on its own, then put together in the browser or on the server. A slice (also called a fragment, or a remote in Module Federation) is a whole vertical, with its own screens calling its own services, so cut by ownership, not by technology layer. The test is whether a slice can go out on a day nobody else releases; if not, it is a module, not a micro-frontend. Choose it over one shared front-end codebase when several teams block each other's releases and the slices follow real business areas, such as search, cart and account. With one or two teams the pipelines cost more than they save.

- **Duplicate libraries.** Each slice may ship its own copy of shared libraries, so load the framework once and pin its version.
- **Version skew.** Slices built at different times must still work together, so version the events and URLs between them and test the set before release.
- **Drifting look.** Slices diverge visually, so share a design system package.
- **More to run.** Each slice adds a build and deploy, so share one pipeline template and agree a small standard.

**Example.** A shop has 6 teams and one front-end build of 40 minutes, released every 2 weeks, because a broken change from any team blocks everyone. You split it into 6 slices, all shown on one page. Assume each builds in 6 minutes and ships several times a day. If each slice bundles its own 45 KB framework, a visitor downloads 6 x 45 = 270 KB of it instead of 45 KB. Loading the framework once as a shared module brings it back to 45 KB, but now all six teams must agree on one framework version, and upgrading it needs a joint plan.

## How it works
<!--meta block=structure-->

```mermaid caption="A shell composes several independently built micro-frontends — one per team — into a single application, integrating them at run time or build time."
flowchart TB
    Shell["Shell / host"]
    Shell -->|"mounts at run/build time"| A["Search MFE (team A)"]
    Shell -->|"mounts at run/build time"| B["Cart MFE (team B)"]
    Shell -->|"mounts at run/build time"| C["Account MFE (team C)"]
```

## Variations
<!--meta block=variations-->

- **Build-time integration** — Each slice is published as a versioned package and the shell pulls them in at build time. A slice update rebuilds and redeploys the host, so you trade independence for fewer moving parts at run time. One host build releases every slice together, so it fails the explain test (a slice ships on a day nobody else releases); treat it as a module, a reasonable first step.
- **Run-time composition** — The shell loads slices at run time — most commonly via Module Federation, where one build imports code from another separately deployed build on demand. This preserves true independent deploys: a team ships its slice and the host picks it up without rebuilding.
- **Isolation via iframes or web components** — Wrap each slice so its styles cannot leak into its neighbours. Iframes give the hardest boundary, a separate document with separate globals, so scripts are isolated too, at the cost of slices talking only through messages. Web components (custom elements with shadow DOM (Document Object Model)) isolate styles and DOM only, so globals and script conflicts remain, but the slice stays in one page.
- **Server-side / edge-side composition** — Assemble the fragments into one HTML response on the server or at the CDN (content delivery network) edge before it reaches the browser. Favours first-paint performance and search engine optimization (SEO), and keeps composition logic off the client.
- **View-model composition** — Compose the data rather than the markup: each service contributes the part of a screen's view model it owns, and a composer merges the contributions at request time. It fits when the screen is one page rather than a set of independently rendered regions. The cost moves to the composer, which needs a fan-out with a deadline and a decision about what to render when one contributor is slow.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Independent deploys** — with run-time composition, a team ships its slice on its own cadence without a coordinated release, within a tested version contract. Build-time integration still redeploys the host.
- **Team autonomy**: clear ownership of a slice end to end, with its own pipeline and roadmap.
- **Per-slice tech-stack freedom** — a slice can adopt or upgrade a framework without dragging the rest along. Once a framework is shared at run time, its version is a joint decision.
- **Supports incremental migration**: replace a legacy UI page by page instead of a big-bang rewrite.

### Cons
<!--meta polarity=con-->

- **Duplicated dependencies and larger payloads** — each slice may ship its own copy of shared libraries.
- **Integration and version-skew complexity**: slices built at different times must still interoperate.
- **Harder to keep user experience (UX) consistent** and shared state coherent across independently built pieces.
- **More operational overhead** — more builds, pipelines, and deploys to run and observe.
- **The autonomy that frees each slice's stack** also scatters tooling, linting and practice across teams, and no single build enforces a shared standard.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Multiple teams keep colliding in one frontend** and one another's changes block releases.
- **You want independent deploys** so each team can ship without a coordinated build.
- **You need to migrate a legacy UI incrementally**, one page or section at a time.

### Avoid when
<!--meta polarity=avoid-->

- **The app is small** or owned by a single team — the overhead dwarfs the benefit.
- **Payload size and UX consistency** matter more than deploy independence.
- **You have no clear ownership boundaries** to split the UI along.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a Webpack Module Federation host loading a remote slice"
// webpack.config.ts — the shell/host consumes a remotely deployed slice
import { container } from "webpack";
const { ModuleFederationPlugin } = container;
// One shared copy of each library, inside a pinned range; both builds use it.
const dep = { singleton: true, requiredVersion: "^18.0.0" };
const shared = { react: dep, "react-dom": dep };
// Host: declare which remotes it pulls in at run time.
export const hostConfig = {
  plugins: [
    new ModuleFederationPlugin({
      name: "shell",
      remotes: { cart: "cart@https://cart.example.com/remoteEntry.js" }, // the cart slice, its own deployment
      shared,
    }),
  ],
};
// Remote (the cart team's own build): expose a slice for hosts to import.
export const cartConfig = {
  plugins: [
    new ModuleFederationPlugin({
      name: "cart",
      filename: "remoteEntry.js",
      exposes: { "./Cart": "./src/Cart" },
      shared,
    }),
  ],
};
// In the shell, race the import against a timer so a hung remoteEntry.js cannot hang the page;
// the budget comes from the slice's measured load time. On failure or timeout, render a fallback.
declare const cartLoadBudgetMs: number;
const timeout = (ms: number) => new Promise<never>((_, fail) => setTimeout(() => fail(new Error("remote timeout")), ms));
const Cart = await Promise.race([import("cart/Cart"), timeout(cartLoadBudgetMs)]).then((m) => m.default).catch(() => () => "Cart unavailable");
```

## In the wild
<!--meta block=wild-->

- **single-spa** — A router that mounts and unmounts independently built frontend apps in one shell. {#wild-single-spa}
- **Webpack Module Federation** — Loads code from separately deployed builds at run time to compose one app. {#wild-module-federation}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Composition point** — Build time, server side, or in the browser at run time. Run time lets teams deploy alone and costs load time and version risk.
- **Shared dependencies** — Which libraries every fragment shares and which each one bundles. Sharing saves bytes and ties teams to compatible versions.
- **Contract between shell and fragments** — Custom events, props or a shared store. The narrower the contract, the less teams must coordinate.
- **Routing ownership** — Whether the shell owns the URL and fragments own only sub-routes, or each fragment owns its own pages.

### Signals to watch
<!--meta polarity=signal-->

- **Page weight and load time** — Total JavaScript sent per page and time to interactive. Record both per screen before the split, set a regression budget from that baseline and alert when a page passes it.
- **Duplicate library copies** — How many copies of the framework a page loads. More than one means either the sharing is misconfigured or a slice deliberately pins a different version; check which.
- **Independent deploy rate** — How often each team ships without asking another team. If teams still release together, the boundary is wrong.
- **Fragment failure rate** — How often a remote fails to load, counted per fragment in the shell.

### Failure modes under load
<!--meta polarity=failure-->

- **Version skew** — Fragments built against different versions of a shared library break each other at run time. Pin ranges and test the combinations.
- **Visual drift** — Each team ships its own styles and the product looks stitched. Share a design system and tokens.
- **Remote down** — A fragment fails to load and the page has a hole. The shell needs a fallback and a timeout per fragment, set from that fragment's measured load time; alert when its failure rate passes an agreed budget.
- **Split along the wrong seam** — A single user flow crosses three fragments, so every change needs three teams.

### Readiness checklist
<!--meta polarity=check-->

- Each fragment loads behind an error boundary with a fallback
- The shell tests the actual combination of fragment versions it will ship, including each remote version before it is promoted
- Shared libraries and their version ranges are written down and checked in the build
- One team owns the design tokens and the shell's cross-fragment events

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Split the user interface (UI) into independently deployed slices {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Strangler Fig](../distributed/coordination/strangler-fig.md) — Migrate a legacy frontend slice by slice, each a separately shipped micro-frontend
- [Backend-for-Frontend](../distributed/routing/bff.md) — Each slice ships with its own backend-for-frontend tailored to what it renders
- [API Gateway](../distributed/routing/api-gateway.md) — A gateway or shell routes requests to the right slice and its services
- [Atomic Design](./atomic-design.md) — Shared atoms and molecules hold user experience (UX) consistent across slices
- [Conway's Law](../../principles/conways-law.md) — Slices follow team ownership, so the team boundary and the deploy boundary stay the same line.
- [Vertical Slice](../architecture/vertical-slice.md) — A micro-frontend is a vertical slice given its own build and deploy.
- [Microservices](../architecture/microservices.md) — The UI side of per-team services: each slice talks to the services its team owns.

<!-- relationships:end -->
