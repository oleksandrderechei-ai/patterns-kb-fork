---
title: Atomic Design
description: Build the UI up from atoms through templates to whole pages
area: frontend
owner: Oleksandr Derechei
tags: [ui-architecture, composition]
status: stable
solves: [our buttons and inputs look slightly different on every screen, designers and engineers describe the same UI with different words, I keep rebuilding the same little widgets because nothing is a shared building block, changing one colour means hunting the same button down in twenty files, nobody can say where a new component belongs so it gets copied into whichever page needs it]
---

# Atomic Design

A design-system methodology that composes interfaces from the smallest reusable pieces — atoms into molecules into organisms into templates and pages — so the whole UI is built from one shared, consistent vocabulary.

## What it is
<!--meta block=description-->

Left unmanaged, a UI drifts: buttons and inputs get rebuilt a little differently on every screen, and one thing carries several names. Atomic design arranges the interface in five tiers, atoms, molecules, organisms, templates and pages, where each tier uses the ones below it, so every screen is built from the same shared parts.

## Explained
<!--meta block=explain-->

Atomic design builds an interface in five tiers, where each tier draws on the ones below it, not only the one directly beneath. Atoms are single elements such as a button or an input. Molecules combine a few atoms for one job, such as a search field. Organisms are larger sections such as a header. Templates lay out organisms with placeholders, and pages fill a template with real content. The tiers are a way to read the UI, not a build order. A change to an atom reaches every screen that uses it, and the whole team shares one set of names. Choose it over building each screen on its own when many screens share parts and more than one person builds them, which is how a design system starts.

- **Tier arguments.** People debate molecule versus organism, so write a one-line rule, such as: anything fetching its own data is an organism.
- **Overhead for small apps.** Start with atoms and plain components and add tiers when the same part is copied across screens.
- **Sorting over shipping.** When unsure, pick the lower tier, promote it later if it needs data or composes molecules, and update its imports.

**Example.** An app has 12 screens, and each has its own button with 12 px of padding and square corners. A rebrand wants rounded corners, which means 12 edits in 12 files, and you will miss one. With one Button atom, it is one edit. A search field built from a label, an input and a Button is a molecule, used in the header and on 3 pages, so a fix there reaches 4 places. The cost is a short debate: the team spends 30 minutes deciding whether a price tag with a currency picker is a molecule or an organism. The rule settles it: the picker fetches no data, so it is a molecule.

## How it works
<!--meta block=structure-->

```mermaid caption="The ladder from atoms to pages. A tier draws on any tier below it, not only the one directly beneath, so every page still resolves down to the same shared atoms."
flowchart LR
    A["Atoms: button, input"] -->|"compose into"| M["Molecules: search bar"]
    M -->|"compose into"| O["Organisms: header"]
    O -->|"arrange into"| T["Templates: page layout"]
    T -->|"fill with content"| P["Pages: real content"]
```

## Variations
<!--meta block=variations-->

- **Strict five-tier** — The full atoms / molecules / organisms / templates / pages hierarchy, applied literally. Most explicit, but invites debate about which tier a given component belongs to.
- **Pragmatic component-library tiering** — A looser grouping, primitives / components / patterns. It keeps the compose-from-below rule and drops the five-label debate.
- **Design-token layer underneath the atoms** — Adds a tier below atoms: named values for color, spacing and type. Atoms read tokens, a [single source of truth](../../principles/dry.md), so one change to a token restyles every tier above.
- **Library to organisms, app owns the rest** — The library holds atoms to organisms; templates and pages stay in the app as routes and layouts.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Visual and behavioral consistency** — every screen that uses a shared atom picks up a fix to it at once; screens with local one-off parts do not.
- **Reuse over rebuilding** — a search bar assembled from an input and a button is written once, not once per page.
- **Shared vocabulary** — designers and engineers name the same thing the same way, which shortens review threads and handoffs.
- **Scales across teams** — each team owns a tier or a slice of one, and the tiers give them a contract to build against.

### Cons
<!--meta polarity=con-->

- **Taxonomy debates** — is this a molecule or an organism? — consume time without shipping anything. Settle the call in a written rule of thumb, such as "anything fetching its own data is an organism", and stop arguing case by case.
- **Fixed cost for small apps** — a product with a few screens never recoups the structure. Start with a flat component folder and add tiers when duplication appears.
- **Rigid tiers invite bad fits** — a component that fits no tier is forced into one anyway. Let a tier draw on any tier below it.
- **A catalog that rots** — an atom changed without its consumers visible ripples into screens nobody checked, and a catalog that drifts from the code stops being trusted. Pair the library with visual regression tests or a component catalog so a change shows the captured screens it moves; uncaptured screens stay a risk.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Design system across many screens** — you are building or maintaining one, and teams keep rebuilding the same button with small differences.
- **Design and engineering disagree on names** — you need one component vocabulary that both sides use in reviews and tickets.
- **Multiple teams, one look** — several teams ship screens into one product and need shared parts to keep the interface consistent.

### Avoid when
<!--meta polarity=avoid-->

- **Small app, few screens** — the shared structure costs more than the reuse saves. Keep a flat shared-components folder and add tiers when duplicates appear.
- **Tier debate costs more than consistency** — the team already argues about categories more than it ships. Use looser primitives and components groupings.
- **One-off marketing pages** — screens built once and thrown away gain nothing from a shared hierarchy.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript / JSX — atoms compose into a molecule, then an organism, then a template"
// Atoms: the smallest building blocks. Each tier imports only from tiers below it.
const Button = ({ label }: { label: string }) => <button>{label}</button>;
const Label = ({ text }: { text: string }) => <label>{text}</label>;
const Input = ({ placeholder }: { placeholder: string }) =>
  <input placeholder={placeholder} />;

// Molecule: atoms combined into a small, reusable unit.
const SearchBar = () => (
  <div className="search-bar">
    <Label text="Search" />
    <Input placeholder="Search…" />
    <Button label="Go" />
  </div>
);

// Organism: molecules and atoms assembled into a section of the page.
const Header = () => (
  <header><h1>Acme</h1><SearchBar /></header>
);

// Not allowed: an atom importing Header, an upward import that lint rejects.
// Template: lays out organisms passed in as props; a page fills it with real content.
const PageTemplate = ({ header, body }: { header: React.ReactNode; body: React.ReactNode }) =>
  <main>{header}{body}</main>;

// Page: fills the template with real content.
const HomePage = () => <PageTemplate header={<Header />} body={<p>Hello</p>} />;
```

## In the wild
<!--meta block=wild-->

- **Atomic Design (Brad Frost)** — The methodology that named the atoms to molecules to organisms to templates to pages hierarchy. {#wild-brad-frost-atomic-design}
- **Storybook** — Develops and catalogs UI components in isolation, a natural home for an atomic hierarchy. {#wild-storybook}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Number of tiers** — Five tiers in full, or a looser primitives / components / patterns split. Pick the fewest tiers whose boundaries the team can state in one sentence.
- **Tier admission rule** — The written test that puts a component in a tier, such as "fetches its own data" for an organism. Without it, the same component lands in different tiers per author.
- **Token layer below atoms** — Whether atoms read named values for color, spacing and type, or hard-code them. Tokens give one place to change a brand.
- **Catalog scope** — Which tiers appear in the component catalog: all five, or only atoms to organisms with templates and pages left in the app.

### Signals to watch
<!--meta polarity=signal-->

- **Duplicate components** — Two components that render nearly the same thing, found in code search or review, mean the library is not being used or not found.
- **Tier-placement threads** — Review comments arguing over where a component belongs. A steady flow says the admission rule is vague.
- **Atom change blast radius** — How many screens a one-atom change touches, shown by visual regression runs. A wide spread is expected; a screen nobody listed is the defect.
- **Components outside the library** — Share of screens that use local one-off parts instead of the shared tiers. Count local components per screen with a code search or import scan, record a baseline when the library starts and act on the trend.

### Failure modes under load
<!--meta polarity=failure-->

- **Taxonomy stall** — Pull requests wait on a molecule-versus-organism decision while no behavior changes. Fix by a default rule (when unsure, pick the lower tier and move it later) and a named owner who decides in one comment.
- **Atom bloat** — An atom grows props for every use case until it is a small framework. Split it into variants or a new atom.
- **Upward dependency** — An atom imports from an organism, so the ladder tangles into cycles. A lint rule on import direction catches it.
- **Library nobody opens** — Teams rebuild parts because the catalog is hard to search. The structure exists and the reuse does not.

### Readiness checklist
<!--meta polarity=check-->

- Each tier has a one-sentence admission rule in the contributing guide
- Imports run only from a tier to the tiers below it, and a lint rule enforces it
- Every atom and molecule has a catalog entry with its states shown (or the tiers chosen in the catalog-scope knob)
- A visual regression run covers the atoms, so a change shows which screens move

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Frontend Architecture](../../themes/frontend-architecture.md) — Build the user interface (UI) up from atoms to organisms {#fluency-frontend-architecture}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Composite](../gof/structural/composite.md) — Atoms into molecules into organisms is composite applied to the user interface (UI) tree
- [Composition over Inheritance](../../principles/composition-over-inheritance.md) — Build complex user interface (UI) by composing small components, never by inheriting deep hierarchies
- [Container / Presentational](./container-presentational.md) — Atoms and molecules are the presentational half
- [Micro-Frontends](./micro-frontends.md) — A shared atom library keeps independent slices one app
- [Don't Repeat Yourself (DRY)](../../principles/dry.md) — Each tier applies don't repeat yourself (DRY) to user interface (UI) parts: a button or search field is written once

**Prevents**

- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — One shared atom turns a change that touched every screen into a single edit

<!-- relationships:end -->
